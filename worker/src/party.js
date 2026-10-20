// Port of D:\vsongs\orelacat-jam\party\party.go
// The data model is identical on the wire; only the storage changed. Each
// party lives inside one Durable Object, which is single-threaded, so the Go
// mutexes are no longer needed and every helper runs to completion.

import { randomHex, nowMs } from "./config.js";

export class PartyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.message = message;
  }
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

export function newCode() {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  let out = "";
  // 36 symbols: reject bytes above the last full multiple to stay unbiased.
  const limit = 256 - (256 % ALPHABET.length);
  let i = 0;
  while (out.length < CODE_LENGTH) {
    const b = buf[i % CODE_LENGTH];
    i += 1;
    if (b >= limit) {
      crypto.getRandomValues(buf);
      i = 0;
      continue;
    }
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

export function normaliseCode(code) {
  let out = "";
  for (const ch of String(code || "").trim().toUpperCase()) {
    if (!/[A-Z0-9]/.test(ch)) continue;
    if (ch === "I" || ch === "L") out += "1";
    else if (ch === "O") out += "0";
    else out += ch;
  }
  return out;
}

export function isValidCode(code) {
  if (typeof code !== "string" || code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}

export function trackFromWire(raw) {
  if (!raw || typeof raw !== "object") return null;
  let vid = typeof raw.videoId === "string" ? raw.videoId : "";
  if (!vid) return null;
  if (vid.length > 128) vid = vid.slice(0, 128);

  let title = typeof raw.title === "string" ? raw.title : "";
  if (title.length > 300) title = title.slice(0, 300);
  let artist = typeof raw.artist === "string" ? raw.artist : "";
  if (artist.length > 300) artist = artist.slice(0, 300);

  let thumbnailUrl = null;
  if (typeof raw.thumbnailUrl === "string" && raw.thumbnailUrl !== "") {
    thumbnailUrl = raw.thumbnailUrl.length > 1000 ? raw.thumbnailUrl.slice(0, 1000) : raw.thumbnailUrl;
  }

  let durationMs = null;
  if (typeof raw.durationMs === "number" && raw.durationMs > 0) durationMs = Math.trunc(raw.durationMs);

  return {
    videoId: vid,
    title,
    artist,
    thumbnailUrl,
    durationMs,
    fromAutoplay: raw.fromAutoplay === true,
  };
}

export function trackToWire(t) {
  if (!t) return null;
  const out = {
    videoId: t.videoId,
    title: t.title,
    artist: t.artist,
    fromAutoplay: t.fromAutoplay === true,
  };
  if (t.thumbnailUrl !== null && t.thumbnailUrl !== undefined) out.thumbnailUrl = t.thumbnailUrl;
  if (t.durationMs !== null && t.durationMs !== undefined) out.durationMs = t.durationMs;
  return out;
}

export function validateJoinRequest(req) {
  if (!req || typeof req !== "object") {
    return { ok: false, message: "userId must be between 1 and 128 characters" };
  }
  const userId = String(req.userId ?? "").trim();
  if (!userId || userId.length > 128) {
    return { ok: false, message: "userId must be between 1 and 128 characters" };
  }
  const deviceId = String(req.deviceId ?? "").trim();
  if (!deviceId || deviceId.length > 128) {
    return { ok: false, message: "deviceId must be between 1 and 128 characters" };
  }
  const displayName = String(req.displayName ?? "").trim();
  if (!displayName || displayName.length > 80) {
    return { ok: false, message: "displayName must be between 1 and 80 characters" };
  }

  let avatarUrl = null;
  if (req.avatarUrl !== undefined && req.avatarUrl !== null) {
    const trimmed = String(req.avatarUrl).trim();
    if (trimmed === "") avatarUrl = null;
    else if (trimmed.length > 1000) return { ok: false, message: "avatarUrl must not exceed 1000 characters" };
    else if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      return { ok: false, message: "avatarUrl must be an http(s) URL" };
    } else avatarUrl = trimmed;
  }

  let maxMembers = null;
  if (req.maxMembers !== undefined && req.maxMembers !== null) {
    const n = Number(req.maxMembers);
    if (!Number.isFinite(n) || n < 2 || n > 10) return { ok: false, message: "maxMembers must be between 2 and 10" };
    maxMembers = Math.trunc(n);
  }

  let autoplayEnabled = null;
  if (typeof req.autoplayEnabled === "boolean") autoplayEnabled = req.autoplayEnabled;

  return { ok: true, value: { userId, deviceId, displayName, avatarUrl, maxMembers, autoplayEnabled } };
}

// ---------------------------------------------------------------- playback

export function newPlaybackState() {
  const now = nowMs();
  return {
    track: null,
    queue: [],
    queueIndex: -1,
    isPlaying: false,
    positionMs: 0,
    anchorMs: now,
    seq: 0,
    queueSeq: 0,
    updatedBy: null,
    updatedAtMs: now,
    startedBy: null,
    startedByName: null,
    autoplayEnabled: false,
  };
}

export function positionAt(p, serverMs) {
  if (!p.isPlaying) return p.positionMs;
  let elapsed = serverMs - p.anchorMs;
  if (elapsed < 0) elapsed = 0;
  const pos = p.positionMs + elapsed;
  if (p.track && p.track.durationMs !== null && p.track.durationMs > 0 && pos > p.track.durationMs) {
    return p.track.durationMs;
  }
  return pos;
}

function touch(p, memberId) {
  p.seq += 1;
  p.updatedBy = memberId;
  p.updatedAtMs = nowMs();
}

function touchQueue(p, memberId) {
  p.queueSeq += 1;
  p.updatedBy = memberId;
  p.updatedAtMs = nowMs();
}

export function playbackPlay(p, cfg, memberId, positionMs) {
  const now = nowMs();
  let startAt = positionAt(p, now);
  if (positionMs !== null && positionMs !== undefined) startAt = positionMs;
  if (startAt < 0) startAt = 0;
  p.positionMs = startAt;
  p.isPlaying = true;
  p.anchorMs = now + cfg.playLeadMs;
  touch(p, memberId);
}

export function playbackPause(p, cfg, memberId, positionMs) {
  const now = nowMs();
  let pauseAt = positionAt(p, now);
  if (positionMs !== null && positionMs !== undefined) pauseAt = positionMs;
  if (pauseAt < 0) pauseAt = 0;
  p.positionMs = pauseAt;
  p.isPlaying = false;
  p.anchorMs = now;
  touch(p, memberId);
}

export function playbackSeek(p, cfg, memberId, positionMs) {
  if (positionMs < 0) positionMs = 0;
  p.positionMs = positionMs;
  const lead = p.isPlaying ? cfg.playLeadMs : 0;
  p.anchorMs = nowMs() + lead;
  touch(p, memberId);
}

function nearestIndexOf(queue, videoId, around) {
  if (around + 1 >= 0 && around + 1 < queue.length && queue[around + 1].videoId === videoId) return around + 1;
  if (around - 1 >= 0 && around - 1 < queue.length && queue[around - 1].videoId === videoId) return around - 1;
  let best = -1;
  let bestDistance = 0;
  for (let i = 0; i < queue.length; i += 1) {
    if (queue[i].videoId !== videoId) continue;
    let distance = i - around;
    if (distance < 0) distance = -distance * 2 + 1;
    if (best === -1 || distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

export function playbackSetTrack(p, cfg, memberId, track, positionMs, isPlaying, queueIndex, memberName) {
  p.track = track;
  if (positionMs < 0) positionMs = 0;
  p.positionMs = positionMs;
  p.isPlaying = Boolean(isPlaying) && track !== null;
  const lead = p.isPlaying ? cfg.playLeadMs : 0;
  p.anchorMs = nowMs() + lead;

  if (
    queueIndex !== null &&
    queueIndex !== undefined &&
    queueIndex >= 0 &&
    queueIndex < p.queue.length &&
    track !== null &&
    p.queue[queueIndex].videoId === track.videoId
  ) {
    p.queueIndex = queueIndex;
  } else if (track !== null) {
    p.queueIndex = nearestIndexOf(p.queue, track.videoId, p.queueIndex);
  } else if (queueIndex !== null && queueIndex !== undefined) {
    p.queueIndex = queueIndex;
  }

  p.startedBy = memberId;
  p.startedByName = memberName;
  touch(p, memberId);
}

export function playbackSetQueue(p, cfg, memberId, queue, queueIndex) {
  if (p.track !== null) {
    if (queueIndex < 0 || queueIndex >= queue.length || queue[queueIndex].videoId !== p.track.videoId) {
      queueIndex = nearestIndexOf(queue, p.track.videoId, queueIndex);
    }
  }

  if (queueIndex >= 0 && queueIndex < queue.length) {
    const pastAndCurrent = queue.slice(0, queueIndex + 1);
    let endUpcoming = queueIndex + 1 + cfg.maxUpcomingQueue;
    if (endUpcoming > queue.length) endUpcoming = queue.length;
    const upcoming = queue.slice(queueIndex + 1, endUpcoming);
    p.queue = [...pastAndCurrent, ...upcoming];
    p.queueIndex = queueIndex;
  } else {
    let maxLen = cfg.maxQueueLength;
    if (queue.length < maxLen) maxLen = queue.length;
    p.queue = queue.slice(0, maxLen);
    p.queueIndex = queueIndex >= 0 && queueIndex < p.queue.length ? queueIndex : -1;
  }
  touchQueue(p, memberId);
}

function withoutQueuedAutoplay(queue, queueIndex, tracks) {
  const waiting = new Set();
  for (let i = queueIndex + 1; i < queue.length; i += 1) {
    if (i >= 0) waiting.add(queue[i].videoId);
  }
  const out = [];
  for (const t of tracks) {
    if (!t) continue;
    if (t.fromAutoplay) {
      if (waiting.has(t.videoId)) continue;
      waiting.add(t.videoId);
    }
    out.push(t);
  }
  return out;
}

export function playbackAddUpcoming(p, cfg, memberId, tracks, playNext) {
  let currentUpcoming;
  if (p.queueIndex >= 0) {
    currentUpcoming = p.queue.length - 1 - p.queueIndex;
    if (currentUpcoming < 0) currentUpcoming = 0;
  } else {
    currentUpcoming = p.queue.length;
  }

  const slotsLeft = cfg.maxUpcomingQueue - currentUpcoming;
  if (slotsLeft <= 0) return { ok: false, reason: "queue_full" };

  let toAdd = withoutQueuedAutoplay(p.queue, p.queueIndex, tracks);
  if (toAdd.length === 0 && tracks.length > 0) return { ok: true, reason: "" };
  if (toAdd.length > slotsLeft) toAdd = toAdd.slice(0, slotsLeft);
  if (toAdd.length === 0) return { ok: false, reason: "no_tracks" };

  if (playNext && p.queueIndex >= 0 && p.queueIndex < p.queue.length) {
    const insertAt = p.queueIndex + 1;
    p.queue = [...p.queue.slice(0, insertAt), ...toAdd, ...p.queue.slice(insertAt)];
  } else {
    p.queue = [...p.queue, ...toAdd];
  }
  touchQueue(p, memberId);
  return { ok: true, reason: "" };
}

export function playbackRemoveUpcoming(p, memberId, videoId) {
  let match = -1;
  for (let i = 0; i < p.queue.length; i += 1) {
    if (p.queue[i].videoId === videoId) {
      match = i;
      break;
    }
  }
  if (match === -1 || match === p.queueIndex) return false;
  p.queue = [...p.queue.slice(0, match), ...p.queue.slice(match + 1)];
  if (p.queueIndex > match) p.queueIndex -= 1;
  touchQueue(p, memberId);
  return true;
}

export function playbackClearUpcoming(p, memberId) {
  if (p.queueIndex >= 0) {
    if (p.queue.length <= p.queueIndex + 1) return false;
    p.queue = p.queue.slice(0, p.queueIndex + 1);
  } else {
    if (p.queue.length === 0) return false;
    p.queue = [];
  }
  touchQueue(p, memberId);
  return true;
}

export function playbackMoveUpcoming(p, memberId, fromIdx, toIdx, videoId) {
  if (videoId) {
    let match = -1;
    for (let i = 0; i < p.queue.length; i += 1) {
      if (p.queue[i].videoId === videoId) {
        match = i;
        break;
      }
    }
    if (match === -1) return false;
    fromIdx = match;
  }
  if (fromIdx < 0 || fromIdx >= p.queue.length || toIdx < 0 || toIdx >= p.queue.length) return false;
  if (fromIdx <= p.queueIndex || toIdx <= p.queueIndex) return false;
  if (fromIdx === toIdx) return true;

  const item = p.queue[fromIdx];
  const rest = [...p.queue.slice(0, fromIdx), ...p.queue.slice(fromIdx + 1)];
  p.queue = [...rest.slice(0, toIdx), item, ...rest.slice(toIdx)];
  touchQueue(p, memberId);
  return true;
}

export function playbackStep(p, cfg, memberId, delta, memberName) {
  const target = p.queueIndex + delta;
  if (target < 0 || target >= p.queue.length) return false;
  playbackSetTrack(p, cfg, memberId, p.queue[target], 0, true, target, memberName);
  return true;
}

export function playbackToWire(p, serverMs) {
  return {
    seq: p.seq,
    track: trackToWire(p.track),
    queueSeq: p.queueSeq,
    queueIndex: p.queueIndex,
    queueLength: p.queue.length,
    isPlaying: p.isPlaying,
    positionMs: p.positionMs,
    anchorMs: p.anchorMs,
    effectivePositionMs: positionAt(p, serverMs),
    updatedBy: p.updatedBy,
    startedBy: p.startedBy,
    startedByName: p.startedByName,
    autoplayEnabled: p.autoplayEnabled,
    updatedAtMs: p.updatedAtMs,
  };
}

export function queueToWire(p) {
  return { seq: p.queueSeq, index: p.queueIndex, items: p.queue.map(trackToWire) };
}

// ---------------------------------------------------------------- party

export function newParty(code, maxMembers) {
  let cap = maxMembers;
  if (!Number.isFinite(cap) || cap < 2 || cap > 10) cap = 5;
  const now = nowMs();
  return {
    code,
    members: {},
    playback: newPlaybackState(),
    maxMembers: cap,
    hostOnlyControl: false,
    createdAtMs: now,
    touchedAtMs: now,
    emptySinceMs: now,
  };
}

export function memberToWire(m) {
  return {
    memberId: m.memberId,
    userId: m.userId,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    isHost: m.isHost,
    connected: m.connected,
    joinedAtMs: m.joinedAtMs,
    lastSeenMs: m.lastSeenMs,
  };
}

export function partyJoin(p, cfg, userId, deviceId, displayName, avatarUrl) {
  const now = nowMs();
  for (const m of Object.values(p.members)) {
    if (m.deviceId === deviceId) {
      m.displayName = displayName;
      m.avatarUrl = avatarUrl;
      m.userId = userId;
      m.lastSeenMs = now;
      m.token = randomHex(24);
      p.touchedAtMs = nowMs();
      return m;
    }
  }

  if (Object.keys(p.members).length >= p.maxMembers) {
    throw new PartyError(409, "party_full", `This party is full (${p.maxMembers} devices).`);
  }

  const m = {
    memberId: randomHex(8),
    userId,
    deviceId,
    displayName,
    avatarUrl,
    token: randomHex(24),
    isHost: Object.keys(p.members).length === 0,
    connected: false,
    joinedAtMs: now,
    lastSeenMs: now,
    controlBudget: cfg.controlRatePerSecond,
    controlBudgetAtMs: now,
    frameBudget: cfg.frameRatePerSecond,
    frameBudgetAtMs: now,
  };
  p.members[m.memberId] = m;
  p.touchedAtMs = nowMs();
  return m;
}

export function partyAuthenticate(p, token) {
  if (!token) return null;
  for (const m of Object.values(p.members)) {
    if (timingSafeEqual(m.token, token)) return m;
  }
  return null;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function partyRemove(p, memberId) {
  const m = p.members[memberId];
  if (!m) return null;
  delete p.members[memberId];
  if (m.isHost && Object.keys(p.members).length > 0) {
    const next = Object.values(p.members)[0];
    next.isHost = true;
  }
  p.touchedAtMs = nowMs();
  refreshEmptiness(p);
  return m;
}

export function setMaxMembers(p, member, maxMembers) {
  if (!member.isHost) throw new PartyError(403, "host_only", "Only the host can change the party size.");
  if (!Number.isFinite(maxMembers) || maxMembers < 2 || maxMembers > 10) {
    throw new PartyError(422, "invalid_capacity", "Party size must be between 2 and 10.");
  }
  if (maxMembers < Object.keys(p.members).length) {
    throw new PartyError(409, "party_too_small", "Party size cannot be smaller than the current member count.");
  }
  p.maxMembers = maxMembers;
  p.touchedAtMs = nowMs();
}

export function setHostOnlyControl(p, member, enabled) {
  if (!member.isHost) throw new PartyError(403, "host_only", "Only the host can change who controls the music.");
  if (p.hostOnlyControl === enabled) return;
  p.hostOnlyControl = enabled;
  p.touchedAtMs = nowMs();
}

export function mayControl(p, member) {
  return !p.hostOnlyControl || member.isHost;
}

export function spendControlBudget(p, cfg, member) {
  const now = nowMs();
  let elapsedS = (now - member.controlBudgetAtMs) / 1000.0;
  if (elapsedS < 0) elapsedS = 0;
  member.controlBudget = member.controlBudget + elapsedS * cfg.controlRatePerSecond;
  if (member.controlBudget > cfg.controlRatePerSecond) member.controlBudget = cfg.controlRatePerSecond;
  member.controlBudgetAtMs = now;
  if (member.controlBudget < 1.0) return false;
  member.controlBudget -= 1.0;
  return true;
}

export function spendFrameBudget(p, cfg, member) {
  const now = nowMs();
  let elapsedS = (now - member.frameBudgetAtMs) / 1000.0;
  if (elapsedS < 0) elapsedS = 0;
  member.frameBudget += elapsedS * cfg.frameRatePerSecond;
  if (member.frameBudget > cfg.frameRatePerSecond) member.frameBudget = cfg.frameRatePerSecond;
  member.frameBudgetAtMs = now;
  if (member.frameBudget < 1.0) return false;
  member.frameBudget -= 1.0;
  return true;
}

export function markConnected(p, member, connected) {
  member.connected = connected;
  member.lastSeenMs = nowMs();
  p.touchedAtMs = nowMs();
  refreshEmptiness(p);
}

function refreshEmptiness(p) {
  const anyConn = Object.values(p.members).some((m) => m.connected);
  if (anyConn) p.emptySinceMs = null;
  else if (p.emptySinceMs === null) p.emptySinceMs = nowMs();
}

export function expiredMembers(p, cfg, now) {
  return Object.values(p.members).filter((m) => !m.connected && now - m.lastSeenMs > cfg.disconnectGraceMs);
}

export function isExpired(p, cfg, now) {
  if (now - p.createdAtMs > cfg.partyMaxAgeMs) return true;
  if (p.emptySinceMs !== null) return now - p.emptySinceMs > cfg.emptyPartyTtlMs;
  return false;
}

export function partyToWire(p) {
  const now = nowMs();
  const membersList = Object.values(p.members).sort((a, b) => a.joinedAtMs - b.joinedAtMs);
  return {
    code: p.code,
    createdAtMs: p.createdAtMs,
    maxMembers: p.maxMembers,
    hostOnlyControl: p.hostOnlyControl,
    members: membersList.map(memberToWire),
    playback: playbackToWire(p.playback, now),
    queue: queueToWire(p.playback),
    serverMs: now,
  };
}

export function membersFrame(p) {
  return {
    type: "members",
    members: Object.values(p.members).map(memberToWire),
    maxMembers: p.maxMembers,
    hostOnlyControl: p.hostOnlyControl,
    serverMs: nowMs(),
  };
}

export function stateFrame(p) {
  return { type: "state", playback: playbackToWire(p.playback, nowMs()), serverMs: nowMs() };
}

export function queueFrame(p) {
  return { type: "queue", queue: queueToWire(p.playback), serverMs: nowMs() };
}
