// Port of D:\vsongs\orelacat-jam\config\config.go
// Every value keeps the Go default; env vars may override them the same way
// the Go server's JAM_* variables did.

function getInt(env, key, fallback) {
  const raw = env && env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getCsv(env, key, fallback) {
  const raw = env && env[key] !== undefined ? env[key] : fallback;
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBool(env, key, fallback) {
  const raw = env && env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

export function config(env) {
  const maxUpcomingQueue = getInt(env, "JAM_MAX_UPCOMING_QUEUE", 25);
  return {
    maxMembers: getInt(env, "JAM_MAX_MEMBERS", 5),
    stateHeartbeatMs: getInt(env, "JAM_STATE_HEARTBEAT_MS", 5000),
    playLeadMs: getInt(env, "JAM_PLAY_LEAD_MS", 350),
    disconnectGraceMs: getInt(env, "JAM_DISCONNECT_GRACE_MS", 45000),
    emptyPartyTtlMs: getInt(env, "JAM_EMPTY_PARTY_TTL_MS", 120000),
    partyMaxAgeMs: getInt(env, "JAM_PARTY_MAX_AGE_MS", 12 * 60 * 60 * 1000),
    controlRatePerSecond: getInt(env, "JAM_CONTROL_RATE_PER_SECOND", 25),
    maxUpcomingQueue,
    maxQueueLength: getInt(env, "JAM_MAX_QUEUE_LENGTH", 1 + maxUpcomingQueue),
    // Cloudflare Workers has no 0.1-CPU ceiling to plan around, but the room
    // ceiling still bounds how much Durable Object storage a flood can create.
    maxParties: getInt(env, "JAM_MAX_PARTIES", 50),
    createRatePerMinute: getInt(env, "JAM_CREATE_RATE_PER_MINUTE", 2),
    rateLimitMaxEntries: getInt(env, "JAM_RATE_LIMIT_MAX_ENTRIES", 10000),
    requestMaxBytes: getInt(env, "JAM_REQUEST_MAX_BYTES", 16 * 1024),
    webSocketMaxBytes: getInt(env, "JAM_WEBSOCKET_MAX_BYTES", 16 * 1024),
    connectionIdleMs: getInt(env, "JAM_CONNECTION_IDLE_MS", 15 * 60 * 1000),
    frameRatePerSecond: getInt(env, "JAM_FRAME_RATE_PER_SECOND", 30),
    allowedOrigins: getCsv(env, "JAM_ALLOWED_ORIGINS", ""),
    publicOrigin: (env && env.JAM_PUBLIC_ORIGIN ? String(env.JAM_PUBLIC_ORIGIN) : "").replace(/\/+$/, ""),
    presenceIntervalSec: getInt(env, "JAM_PRESENCE_INTERVAL_SEC", 300),
    presenceGraceSec: getInt(env, "JAM_PRESENCE_GRACE_SEC", 90),
    presenceMaxEntries: getInt(env, "JAM_PRESENCE_MAX_ENTRIES", 200000),
    presencePingsPerMinute: getInt(env, "JAM_PRESENCE_PINGS_PER_MINUTE", 20),
  };
}

export function nowMs() {
  return Date.now();
}

export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function jsonResponse(status, data, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders || {}),
    },
  });
}

export function jsonError(status, errCode, message) {
  return jsonResponse(status, { error: errCode, message });
}

// Cloudflare's runtime is single-threaded per Durable Object, so a plain Map is
// the equivalent of the Go limiter's mutex-guarded table. It is per-isolate:
// a fresh isolate starts with empty budgets, which only ever makes the limit
// more permissive for a moment, never stricter.
export class IpRateLimiter {
  constructor(windowMs, limit, maxKeys) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.swept = 0;
  }

  allow(ip) {
    if (this.limit <= 0) return true;
    const now = nowMs();
    if (now - this.swept >= 1000 || (this.maxKeys > 0 && this.entries.size >= this.maxKeys)) {
      for (const [key, entry] of this.entries) {
        if (now - entry.started >= this.windowMs) this.entries.delete(key);
      }
      this.swept = now;
    }
    const entry = this.entries.get(ip);
    if (!entry || now - entry.started >= this.windowMs) {
      if (!entry && this.maxKeys > 0 && this.entries.size >= this.maxKeys) return false;
      this.entries.set(ip, { started: now, count: 1 });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    this.entries.set(ip, entry);
    return true;
  }
}

// Only used for the create-party limit, which the Go server keyed on the
// client address. Behind Cloudflare every request carries CF-Connecting-IP.
export function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}
