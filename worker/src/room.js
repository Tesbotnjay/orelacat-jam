// Port of D:\vsongs\orelacat-jam\hub\hub.go + the party half of main.go.
//
// One Durable Object per party code. Cloudflare runs a single instance of a DO
// at a time, which is what the Go server got from its party mutex and its hub
// mutex; the difference is that a DO can be evicted between messages, so the
// party is written to storage after every change and the sockets use the
// hibernation API, which lets them survive eviction without holding the DO
// awake (that matters: the free plan bills wall-clock duration).
//
// The wire protocol is unchanged. Frames, actions, error codes and rate
// budgets all match the Go server, because the Android client depends on them.

import { config, nowMs, randomHex } from "./config.js";
import {
  PartyError,
  newParty,
  normaliseCode,
  isValidCode,
  partyJoin,
  partyAuthenticate,
  partyRemove,
  partyToWire,
  memberToWire,
  membersFrame,
  stateFrame,
  queueFrame,
  validateJoinRequest,
  trackFromWire,
  setMaxMembers,
  setHostOnlyControl,
  mayControl,
  spendControlBudget,
  spendFrameBudget,
  markConnected,
  expiredMembers,
  isExpired,
  playbackPlay,
  playbackPause,
  playbackSeek,
  playbackSetTrack,
  playbackSetQueue,
  playbackAddUpcoming,
  playbackRemoveUpcoming,
  playbackClearUpcoming,
  playbackMoveUpcoming,
  playbackStep,
  playbackToWire,
} from "./party.js";

const FRAME_WELCOME = "welcome";
const FRAME_STATE = "state";
const FRAME_QUEUE = "queue";
const FRAME_MEMBERS = "members";
const FRAME_PONG = "pong";
const FRAME_ERROR = "error";
const FRAME_BYE = "bye";
const FRAME_ACTIVITY = "activity";

const FRAME_PING = "ping";
const FRAME_CONTROL = "control";
const FRAME_SYNC = "sync";
const FRAME_SYNC_QUEUE = "syncQueue";
const FRAME_REPORT = "report";

const ACTION_PLAY = "play";
const ACTION_PAUSE = "pause";
const ACTION_SEEK = "seek";
const ACTION_SET_TRACK = "setTrack";
const ACTION_SET_QUEUE = "setQueue";
const ACTION_QUEUE_ADD = "queueAdd";
const ACTION_QUEUE_REMOVE = "queueRemove";
const ACTION_QUEUE_CLEAR = "queueClear";
const ACTION_QUEUE_MOVE = "queueMove";
const ACTION_NEXT = "next";
const ACTION_PREVIOUS = "previous";
const ACTION_KICK = "kick";
const ACTION_SET_MAX_MEMBERS = "setMaxMembers";
const ACTION_SET_AUTOPLAY = "setAutoplay";
const ACTION_SET_HOST_ONLY_CONTROL = "setHostOnlyControl";

const CONTROL_ACTIONS = new Set([
  ACTION_PLAY,
  ACTION_PAUSE,
  ACTION_SEEK,
  ACTION_SET_TRACK,
  ACTION_SET_QUEUE,
  ACTION_QUEUE_ADD,
  ACTION_QUEUE_REMOVE,
  ACTION_QUEUE_CLEAR,
  ACTION_QUEUE_MOVE,
  ACTION_NEXT,
  ACTION_PREVIOUS,
  ACTION_SET_AUTOPLAY,
]);

const SOCKET_PROTOCOL = "orelacat.v1";
const SOCKET_TOKEN_PREFIX = "orelacat.token.";

export class PartyRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cfg = config(env);
    this.party = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get("party");
    this.party = stored || null;
    this.loaded = true;
  }

  async save() {
    if (!this.party) return;
    await this.ctx.storage.put("party", this.party);
  }

  // The Go server broadcast a state frame every StateHeartbeatMs to every party
  // with a live socket. An alarm does the same here and then re-arms itself.
  async scheduleHeartbeat() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(nowMs() + this.cfg.stateHeartbeatMs);
    }
  }

  async alarm() {
    await this.load();
    if (!this.party) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = nowMs();
    const sockets = this.ctx.getWebSockets();

    // Sweep, exactly as the Go heartbeat ticker did.
    const gone = expiredMembers(this.party, this.cfg, now);
    let changed = false;
    for (const m of gone) {
      partyRemove(this.party, m.memberId);
      changed = true;
    }
    if (isExpired(this.party, this.cfg, now)) {
      this.party = null;
      await this.ctx.storage.deleteAll();
      for (const ws of sockets) {
        try {
          ws.close(1000, "party expired");
        } catch {}
      }
      return;
    }

    if (sockets.length > 0) {
      this.broadcast(stateFrame(this.party), "");
      if (changed) this.broadcast(membersFrame(this.party), "");
    }

    await this.save();
    await this.ctx.storage.setAlarm(nowMs() + this.cfg.stateHeartbeatMs);
  }

  broadcast(frame, skipMemberId) {
    const payload = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      const id = ws.deserializeAttachment()?.memberId;
      if (skipMemberId && id === skipMemberId) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }

  sendTo(memberId, frame) {
    const payload = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.memberId === memberId) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  closeMember(memberId) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.memberId === memberId) {
        try {
          ws.close(1000, "bye");
        } catch {}
      }
    }
  }

  json(status, data) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  err(status, code, message) {
    return this.json(status, { error: code, message });
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/create" && request.method === "POST") return this.handleCreate(request);
    if (path === "/join" && request.method === "POST") return this.handleJoin(request);
    if (path === "/preview" && request.method === "GET") return this.handlePreview();
    if (path === "/state" && request.method === "GET") return this.handleGetParty(request);
    if (path === "/leave" && request.method === "POST") return this.handleLeave(request);
    if (path === "/ws") return this.handleWebSocket(request);
    if (path === "/invite" && request.method === "GET") {
      if (!this.party) return this.json(404, { exists: false });
      const pb = this.party.playback;
      return this.json(200, {
        exists: true,
        code: this.party.code,
        memberCount: Object.keys(this.party.members).length,
        maxMembers: this.party.maxMembers,
        currentSongTitle: pb.track ? pb.track.title : "",
        currentSongArtist: pb.track ? pb.track.artist : "",
      });
    }
    if (path === "/info" && request.method === "GET") {
      if (!this.party) return this.json(404, { exists: false });
      return this.json(200, {
        exists: true,
        code: this.party.code,
        memberCount: Object.keys(this.party.members).length,
        maxMembers: this.party.maxMembers,
        hasSockets: this.ctx.getWebSockets().length > 0,
      });
    }
    return this.err(404, "not_found", "Unknown room route.");
  }

  async handleCreate(request) {
    const body = await request.json().catch(() => null);
    const v = validateJoinRequest(body);
    if (!v.ok) return this.err(422, "validation_error", v.message);
    const code = url_code(request);

    if (this.party) return this.err(409, "already_exists", "This party code is already in use.");
    this.party = newParty(code, v.value.maxMembers ?? this.cfg.maxMembers);
    if (v.value.autoplayEnabled !== null) {
      this.party.playback.autoplayEnabled = v.value.autoplayEnabled;
    }

    let member;
    try {
      member = partyJoin(
        this.party,
        this.cfg,
        v.value.userId,
        v.value.deviceId,
        v.value.displayName,
        v.value.avatarUrl,
      );
    } catch (e) {
      this.party = null;
      if (e instanceof PartyError) return this.err(e.status, e.code, e.message);
      return this.err(500, "server_error", "Failed to create party.");
    }

    const partyWire = partyToWire(this.party);
    const youWire = memberToWire(member);
    const token = member.token;
    await this.save();
    await this.scheduleHeartbeat();

    return this.json(201, { code: this.party.code, token, you: youWire, party: partyWire });
  }

  async handleJoin(request) {
    if (!this.party) return this.err(404, "no_such_party", "No party with that code.");
    const body = await request.json().catch(() => null);
    const v = validateJoinRequest(body);
    if (!v.ok) return this.err(422, "validation_error", v.message);

    let member;
    try {
      member = partyJoin(
        this.party,
        this.cfg,
        v.value.userId,
        v.value.deviceId,
        v.value.displayName,
        v.value.avatarUrl,
      );
    } catch (e) {
      if (e instanceof PartyError) return this.err(e.status, e.code, e.message);
      return this.err(500, "server_error", String(e && e.message ? e.message : e));
    }

    const partyWire = partyToWire(this.party);
    const youWire = memberToWire(member);
    const token = member.token;
    await this.save();
    await this.scheduleHeartbeat();

    return this.json(200, { code: this.party.code, token, you: youWire, party: partyWire });
  }

  handlePreview() {
    if (!this.party) return this.err(404, "no_such_party", "No party with that code.");
    const ordered = Object.values(this.party.members).sort((a, b) => a.joinedAtMs - b.joinedAtMs);
    const members = ordered.map((m) => ({
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      isHost: m.isHost,
    }));
    const host = ordered.find((m) => m.isHost);
    return this.json(200, {
      code: this.party.code,
      hostName: host ? host.displayName : "",
      memberCount: ordered.length,
      maxMembers: this.party.maxMembers,
      isFull: ordered.length >= this.party.maxMembers,
      members,
    });
  }

  handleGetParty(request) {
    const token = bearer(request);
    if (!token) return this.err(401, "unauthorized", "Missing bearer token.");
    if (!this.party) return this.err(404, "no_such_party", "No party with that code.");
    const member = partyAuthenticate(this.party, token);
    if (!member) return this.err(401, "bad_token", "This device is not a member of that party.");
    return this.json(200, partyToWire(this.party));
  }

  async handleLeave(request) {
    const token = bearer(request);
    if (!token) return this.err(401, "unauthorized", "Missing bearer token.");
    if (!this.party) return this.err(404, "no_such_party", "No party with that code.");
    const member = partyAuthenticate(this.party, token);
    if (!member) return this.err(401, "bad_token", "This device is not a member of that party.");

    const memberId = member.memberId;
    partyRemove(this.party, memberId);
    const frame = membersFrame(this.party);
    this.sendTo(memberId, { type: FRAME_BYE, reason: "left" });
    this.broadcast(frame, memberId);
    this.closeMember(memberId);
    await this.save();
    return this.json(200, { ok: true });
  }

  async handleWebSocket(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return this.err(400, "expected_websocket", "Expected a WebSocket upgrade.");
    }

    const token = socketToken(request);
    if (!token) return new Response("missing token", { status: 401 });
    if (!this.party) return new Response("no such party", { status: 404 });

    const member = partyAuthenticate(this.party, token);
    if (!member) return new Response("bad token", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation: the socket stays open while the DO sleeps, and wakes on a
    // message. That is what makes a party survive the free plan's idle rules.
    this.ctx.acceptWebSocket(server, [member.memberId]);
    server.serializeAttachment({ memberId: member.memberId });

    // Answer the browser's offered subprotocol without echoing its token.
    const offered = (request.headers.get("sec-websocket-protocol") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = {};
    if (offered.includes(SOCKET_PROTOCOL)) headers["sec-websocket-protocol"] = SOCKET_PROTOCOL;

    markConnected(this.party, member, true);
    const welcome = {
      type: FRAME_WELCOME,
      you: memberToWire(member),
      party: partyToWire(this.party),
      serverMs: nowMs(),
    };
    try {
      server.send(JSON.stringify(welcome));
    } catch {}
    this.broadcast(membersFrame(this.party), "");
    await this.save();
    await this.scheduleHeartbeat();

    return new Response(null, { status: 101, webSocket: client, headers });
  }

  // ---------------------------------------------------------- hibernation

  async webSocketMessage(ws, message) {
    await this.load();
    if (!this.party) {
      try {
        ws.close(1000, "no party");
      } catch {}
      return;
    }
    const memberId = ws.deserializeAttachment()?.memberId;
    const member = this.party.members[memberId];
    if (!member) {
      try {
        ws.close(1000, "not a member");
      } catch {}
      return;
    }

    let frame;
    try {
      frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string" || frame.type === "") return;

    const reply = (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {}
    };

    if (!spendFrameBudget(this.party, this.cfg, member)) {
      reply({ type: FRAME_ERROR, error: "rate_limited", message: "Too many messages at once." });
      return;
    }
    member.lastSeenMs = nowMs();

    switch (frame.type) {
      case FRAME_PING:
        reply({ type: FRAME_PONG, clientMs: frame.clientMs ?? null, serverMs: nowMs() });
        return;

      case FRAME_SYNC:
        reply(stateFrame(this.party));
        return;

      case FRAME_SYNC_QUEUE:
        reply(queueFrame(this.party));
        return;

      case FRAME_REPORT:
        // Playhead report from a client, kept as a no-op: the Go server only
        // logged drift, and a Worker has no log worth streaming per tick.
        return;

      case FRAME_CONTROL:
        await this.handleControl(ws, member, frame, reply);
        return;

      default:
        return;
    }
  }

  async handleControl(ws, member, frame, reply) {
    if (!spendControlBudget(this.party, this.cfg, member)) {
      reply({ type: FRAME_ERROR, error: "rate_limited", message: "Too many controls at once." });
      return;
    }

    const queueBefore = this.party.playback.queueSeq;
    const action = typeof frame.action === "string" ? frame.action : "";
    const result = this.applyControl(member, action, frame);

    if (result.ok) {
      this.party.touchedAtMs = nowMs();
      if (this.party.playback.queueSeq !== queueBefore) {
        this.broadcast(queueFrame(this.party), "");
      }
      this.broadcast(stateFrame(this.party), "");
      if (
        action === ACTION_KICK ||
        action === ACTION_SET_MAX_MEMBERS ||
        action === ACTION_SET_HOST_ONLY_CONTROL
      ) {
        this.broadcast(membersFrame(this.party), "");
      }
      this.broadcast(activityFrame(member, action, frame), "");
      await this.save();
      await this.scheduleHeartbeat();
    } else if (result.code) {
      reply({ type: FRAME_ERROR, error: result.code, message: result.message });
    }
  }

  applyControl(member, action, frame) {
    const cfg = this.cfg;
    const p = this.party;

    // Host-only control is enforced here, not left to clients.
    if (CONTROL_ACTIONS.has(action) && !mayControl(p, member)) {
      return { ok: false, code: "host_only", message: "Only the host can control the music in this party." };
    }

    const posPtr =
      typeof frame.positionMs === "number" && Number.isFinite(frame.positionMs)
        ? Math.trunc(frame.positionMs)
        : null;

    switch (action) {
      case ACTION_PLAY:
        playbackPlay(p.playback, cfg, member.memberId, posPtr);
        return { ok: true };

      case ACTION_PAUSE:
        playbackPause(p.playback, cfg, member.memberId, posPtr);
        return { ok: true };

      case ACTION_SEEK:
        if (posPtr === null) return { ok: false, code: "missing_position", message: "seek requires positionMs" };
        playbackSeek(p.playback, cfg, member.memberId, posPtr);
        return { ok: true };

      case ACTION_SET_TRACK: {
        const t = trackFromWire(frame.track);
        if (!t) return { ok: false, code: "invalid_track", message: "Track must include videoId" };
        const pos = posPtr ?? 0;
        const isPlaying = typeof frame.isPlaying === "boolean" ? frame.isPlaying : true;
        const qIndex =
          typeof frame.queueIndex === "number" && Number.isFinite(frame.queueIndex)
            ? Math.trunc(frame.queueIndex)
            : null;
        playbackSetTrack(p.playback, cfg, member.memberId, t, pos, isPlaying, qIndex, member.displayName);
        return { ok: true };
      }

      case ACTION_SET_QUEUE: {
        const items = Array.isArray(frame.queue) ? frame.queue : [];
        const tracks = [];
        for (const item of items) {
          const tr = trackFromWire(item);
          if (tr) tracks.push(tr);
        }
        const qIdx =
          typeof frame.queueIndex === "number" && Number.isFinite(frame.queueIndex)
            ? Math.trunc(frame.queueIndex)
            : -1;
        playbackSetQueue(p.playback, cfg, member.memberId, tracks, qIdx);
        return { ok: true };
      }

      case ACTION_QUEUE_ADD: {
        const toAdd = [];
        if (frame.track) {
          const tr = trackFromWire(frame.track);
          if (tr) toAdd.push(tr);
        } else if (Array.isArray(frame.tracks)) {
          for (const item of frame.tracks) {
            const tr = trackFromWire(item);
            if (tr) toAdd.push(tr);
          }
        }
        const playNext = frame.playNext === true;
        const res = playbackAddUpcoming(p.playback, cfg, member.memberId, toAdd, playNext);
        if (!res.ok) {
          if (res.reason === "queue_full") {
            return {
              ok: false,
              code: "queue_full",
              message: `Queue is full (maximum ${cfg.maxUpcomingQueue} upcoming songs).`,
            };
          }
          return { ok: false, code: res.reason, message: "Could not add track to queue." };
        }
        return { ok: true };
      }

      case ACTION_QUEUE_REMOVE: {
        let vid = typeof frame.videoId === "string" ? frame.videoId : "";
        if (!vid && typeof frame.index === "number" && Number.isFinite(frame.index)) {
          const idx = Math.trunc(frame.index);
          if (idx >= 0 && idx < p.playback.queue.length) vid = p.playback.queue[idx].videoId;
        }
        if (!vid) {
          return { ok: false, code: "missing_track", message: "queueRemove requires videoId or index" };
        }
        if (!playbackRemoveUpcoming(p.playback, member.memberId, vid)) {
          return { ok: false, code: "not_found", message: "Track is not in the upcoming queue" };
        }
        return { ok: true };
      }

      case ACTION_QUEUE_CLEAR:
        if (!playbackClearUpcoming(p.playback, member.memberId)) {
          return { ok: false, code: "no_upcoming", message: "No upcoming tracks to clear" };
        }
        return { ok: true };

      case ACTION_QUEUE_MOVE: {
        const from = typeof frame.fromIndex === "number" ? frame.fromIndex : null;
        const to = typeof frame.toIndex === "number" ? frame.toIndex : null;
        if (from === null || to === null) {
          return { ok: false, code: "missing_indices", message: "queueMove requires fromIndex and toIndex" };
        }
        const videoId = typeof frame.videoId === "string" ? frame.videoId : "";
        if (!playbackMoveUpcoming(p.playback, member.memberId, Math.trunc(from), Math.trunc(to), videoId)) {
          return { ok: false, code: "invalid_move", message: "Invalid queue move indices" };
        }
        return { ok: true };
      }

      case ACTION_NEXT:
        if (!playbackStep(p.playback, cfg, member.memberId, 1, member.displayName)) {
          return { ok: false, code: "end_of_queue", message: "Already at the end of the queue." };
        }
        return { ok: true };

      case ACTION_PREVIOUS:
        if (!playbackStep(p.playback, cfg, member.memberId, -1, member.displayName)) {
          return { ok: false, code: "start_of_queue", message: "Already at the beginning of the queue." };
        }
        return { ok: true };

      case ACTION_SET_MAX_MEMBERS: {
        if (typeof frame.maxMembers !== "number") {
          return { ok: false, code: "invalid_capacity", message: "Choose a party size between 2 and 10." };
        }
        try {
          setMaxMembers(p, member, Math.trunc(frame.maxMembers));
        } catch (e) {
          return { ok: false, code: e.code || "invalid_capacity", message: e.message };
        }
        return { ok: true };
      }

      case ACTION_SET_AUTOPLAY: {
        if (typeof frame.enabled !== "boolean") {
          return { ok: false, code: "invalid_autoplay", message: "AutoPlay must be enabled or disabled." };
        }
        if (p.playback.autoplayEnabled !== frame.enabled) {
          p.playback.autoplayEnabled = frame.enabled;
          p.playback.updatedBy = member.memberId;
          p.playback.updatedAtMs = nowMs();
        }
        return { ok: true };
      }

      case ACTION_SET_HOST_ONLY_CONTROL: {
        if (typeof frame.enabled !== "boolean") {
          return {
            ok: false,
            code: "invalid_control_policy",
            message: "Host-only control must be enabled or disabled.",
          };
        }
        try {
          setHostOnlyControl(p, member, frame.enabled);
        } catch (e) {
          return { ok: false, code: e.code || "invalid_control_policy", message: e.message };
        }
        return { ok: true };
      }

      case ACTION_KICK: {
        const targetId = typeof frame.memberId === "string" ? frame.memberId : "";
        if (!member.isHost) return { ok: false, code: "host_only", message: "Only the host can remove listeners." };
        if (!targetId || targetId === member.memberId) {
          return { ok: false, code: "invalid_member", message: "Choose another listener to remove." };
        }
        if (partyRemove(p, targetId) === null) {
          return { ok: false, code: "not_found", message: "That listener is no longer in this party." };
        }
        this.sendTo(targetId, {
          type: FRAME_BYE,
          reason: "kicked",
          message: "The host removed you from this party.",
        });
        this.closeMember(targetId);
        return { ok: true };
      }

      default:
        return { ok: false, code: "unknown_action", message: `Unknown control action '${action}'` };
    }
  }

  async webSocketClose(ws) {
    await this.load();
    const memberId = ws.deserializeAttachment()?.memberId;
    if (!this.party || !memberId) return;
    const member = this.party.members[memberId];
    if (!member) return;
    markConnected(this.party, member, false);
    this.broadcast(membersFrame(this.party), "");
    await this.save();
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}

function url_code(request) {
  const url = new URL(request.url);
  return normaliseCode(url.searchParams.get("code") || "");
}

function bearer(request) {
  const auth = request.headers.get("authorization") || "";
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1].trim();
  return "";
}

// Browsers cannot set headers on a WebSocket handshake, so the web player
// offers its token as a subprotocol: "orelacat.v1, orelacat.token.<hex>".
function socketToken(request) {
  const fromHeader = bearer(request);
  if (fromHeader) return fromHeader;
  const offered = (request.headers.get("sec-websocket-protocol") || "").split(",");
  for (const raw of offered) {
    const proto = raw.trim();
    if (proto.startsWith(SOCKET_TOKEN_PREFIX)) return proto.slice(SOCKET_TOKEN_PREFIX.length);
  }
  return "";
}

function activityFrame(member, action, frame) {
  let detail = action;
  const trackTitle = (raw) => (raw && typeof raw.title === "string" ? raw.title : "");
  switch (action) {
    case ACTION_SET_TRACK: {
      const title = trackTitle(frame.track);
      if (title) detail = `Changed the song to "${title}"`;
      break;
    }
    case ACTION_QUEUE_ADD: {
      if (Array.isArray(frame.tracks) && frame.tracks.length > 0) {
        const title = trackTitle(frame.tracks[0]);
        if (title) {
          detail =
            frame.tracks.length === 1
              ? `Added "${title}" to the queue`
              : `Added "${title}" and ${frame.tracks.length - 1} more to the queue`;
        }
      }
      break;
    }
    case ACTION_SET_QUEUE:
      if (Array.isArray(frame.queue)) detail = `Replaced the queue with ${frame.queue.length} tracks`;
      break;
    case ACTION_QUEUE_REMOVE:
      detail = "Removed a track from the queue";
      break;
    case ACTION_QUEUE_CLEAR:
      detail = "Cleared upcoming tracks";
      break;
    case ACTION_QUEUE_MOVE:
      detail = "Reordered the upcoming queue";
      break;
    case ACTION_NEXT:
      detail = "Skipped to the next song";
      break;
    case ACTION_PREVIOUS:
      detail = "Went back to the previous song";
      break;
    case ACTION_PLAY:
      detail = "Started playback";
      break;
    case ACTION_PAUSE:
      detail = "Paused playback";
      break;
    case ACTION_SEEK:
      detail = "Changed the playback position";
      break;
    case ACTION_KICK:
      detail = "Removed a listener from the party";
      break;
    case ACTION_SET_MAX_MEMBERS:
      detail = "Changed the party size";
      break;
    case ACTION_SET_AUTOPLAY:
      detail = "Changed AutoPlay";
      break;
    default:
      break;
  }
  return {
    type: FRAME_ACTIVITY,
    action,
    by: member.displayName,
    detail,
    atMs: nowMs(),
  };
}
