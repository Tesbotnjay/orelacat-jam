// Port of D:\vsongs\orelacat-jam\main.go (the HTTP layer).
//
// Routing, CORS, the open-app counter, the live badge and the invite landing
// page all live here; each party lives in its own Durable Object (room.js) and
// the open-app counter in another (presence.js).

import { config, clientIp, IpRateLimiter, jsonResponse, jsonError } from "./config.js";
import { newCode, normaliseCode, isValidCode } from "./party.js";
import { PresenceDO } from "./presence.js";
import { DirectoryDO } from "./directory.js";

export { PartyRoom } from "./room.js";
export { PresenceDO, DirectoryDO };

const createLimiter = new IpRateLimiter(60 * 1000, 2, 10000);

export default {
  async fetch(request, env, ctx) {
    const cfg = config(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS, matching corsMiddleware in the Go server.
    const origin = request.headers.get("origin") || "";
    const allowed = origin !== "" && cfg.allowedOrigins.includes(origin);
    const corsHeaders = allowed
      ? {
          "access-control-allow-origin": origin,
          vary: "origin",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization",
        }
      : {};

    if (request.method === "OPTIONS") {
      if (origin !== "" && !allowed) return new Response("origin not allowed", { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    let response;
    try {
      response = await route(request, env, cfg, url, path);
    } catch (e) {
      response = jsonError(500, "server_error", String(e && e.message ? e.message : e));
    }

    if (Object.keys(corsHeaders).length > 0) {
      const merged = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
      return new Response(response.body, { status: response.status, headers: merged });
    }
    return response;
  },
};

async function route(request, env, cfg, url, path) {
  // ---- REST endpoints
  if (path === "/" && request.method === "GET") {
    const counts = await presenceCounts(env);
    const parties = await directoryCount(env);
    return jsonResponse(200, {
      service: "orelacat-listen-together",
      members: counts.online ?? 0,
      parties,
      serverMs: Date.now(),
    });
  }

  if (path === "/healthz" && request.method === "GET") {
    return jsonResponse(200, { ok: true, serverMs: Date.now() });
  }

  if (path === "/api/time" && request.method === "GET") {
    return jsonResponse(200, { serverMs: Date.now() });
  }

  if (path === "/api/parties" && request.method === "POST") {
    return createParty(request, env, cfg);
  }

  let m = path.match(/^\/api\/parties\/([^/]+)\/join$/);
  if (m && request.method === "POST") {
    const code = normaliseCode(decodeURIComponent(m[1]));
    if (!isValidCode(code)) return jsonError(422, "invalid_code", "Party codes are 6 characters.");
    return roomFetch(env, code, new Request(new URL("/join", url), request), "POST");
  }

  m = path.match(/^\/api\/parties\/([^/]+)\/preview$/);
  if (m && request.method === "GET") {
    const code = normaliseCode(decodeURIComponent(m[1]));
    if (!isValidCode(code)) return jsonError(404, "no_such_party", "No party with that code.");
    return roomFetch(env, code, new Request(new URL("/preview", url), { method: "GET" }), "GET");
  }

  m = path.match(/^\/api\/parties\/([^/]+)\/leave$/);
  if (m && request.method === "POST") {
    const code = normaliseCode(decodeURIComponent(m[1]));
    if (!isValidCode(code)) return jsonError(404, "no_such_party", "No party with that code.");
    const headers = new Headers();
    const auth = request.headers.get("authorization");
    if (auth) headers.set("authorization", auth);
    return roomFetch(
      env,
      code,
      new Request(new URL("/leave", url), { method: "POST", headers }),
      "POST",
    );
  }

  m = path.match(/^\/api\/parties\/([^/]+)$/);
  if (m && request.method === "GET") {
    const code = normaliseCode(decodeURIComponent(m[1]));
    if (!isValidCode(code)) return jsonError(404, "no_such_party", "No party with that code.");
    const headers = new Headers();
    const auth = request.headers.get("authorization");
    if (auth) headers.set("authorization", auth);
    return roomFetch(env, code, new Request(new URL("/state", url), { method: "GET", headers }), "GET");
  }

  // ---- Open-app counter
  if (path === "/api/presence" && request.method === "POST") {
    return handlePresence(request, env, cfg);
  }
  if (path === "/api/stats/live" && request.method === "GET") {
    const counts = await presenceCounts(env);
    return jsonResponse(200, counts, {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=15",
    });
  }
  if (path === "/api/stats/live/badge.svg" && request.method === "GET") {
    const counts = await presenceCounts(env);
    return liveBadge(counts.online ?? 0);
  }

  // ---- Web invite landing
  m = path.match(/^\/invite\/([^/]+)$/);
  if (m && request.method === "GET") {
    return inviteLanding(env, cfg, url, decodeURIComponent(m[1]));
  }

  // ---- WebSocket
  m = path.match(/^\/ws\/parties\/([^/]+)$/);
  if (m) {
    const code = normaliseCode(decodeURIComponent(m[1]));
    if (!isValidCode(code)) return new Response("no such party", { status: 404 });
    return roomFetch(env, code, new Request(new URL("/ws", url), request), request.method);
  }

  return jsonError(404, "not_found", "No such endpoint.");
}

function roomStub(env, code) {
  return env.PARTY_ROOM.get(env.PARTY_ROOM.idFromName(`party:${code}`));
}

function roomFetch(env, code, request, method) {
  return roomStub(env, code).fetch(request, { method });
}

async function createParty(request, env, cfg) {
  if (!createLimiter.allow(clientIp(request))) {
    return jsonError(
      429,
      "create_rate_limited",
      "You can create up to two parties per minute. Please try again shortly.",
    );
  }

  const body = await request.clone().json().catch(() => null);

  // Reserve a code in the directory first so the service-wide room ceiling is
  // enforced in one place, the way PartyStore.CreateWithLimits did.
  let code = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = newCode();
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("global-directory"));
    const res = await dir.fetch(`https://directory/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: candidate }),
    });
    if (res.status === 201) {
      code = candidate;
      break;
    }
    if (res.status === 503) {
      const data = await res.json().catch(() => ({}));
      return jsonError(503, data.error || "server_full", data.message || "The party server is busy.");
    }
  }
  if (!code) return jsonError(503, "code_exhausted", "Could not allocate a party code.");

  const headers = new Headers();
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const createUrl = new URL(`https://room/create`);
  createUrl.searchParams.set("code", code);
  const res = await roomStub(env, code).fetch(
    new Request(createUrl, { method: "POST", headers, body: JSON.stringify(body) }),
  );

  if (res.status !== 201) {
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("global-directory"));
    await dir.fetch(`https://directory/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  }
  return res;
}

async function handlePresence(request, env, cfg) {
  // Only the apps ping, and they send no Origin.
  if (request.headers.get("origin")) {
    return jsonError(403, "origin_not_allowed", "Presence is only accepted from the apps.");
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError(422, "invalid_json", "Malformed JSON body.");
  }
  const id = String(body.id ?? "");
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return jsonError(422, "invalid_id", "id must be a UUID.");
  }
  const platform = String(body.platform ?? "");
  if (platform !== "android" && platform !== "pc") {
    return jsonError(422, "invalid_platform", "platform must be android or pc.");
  }
  if (typeof body.open !== "boolean") {
    return jsonError(422, "invalid_open", "open must be true or false.");
  }

  const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global-presence"));
  await stub.fetch("https://presence/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, platform, open: body.open, ip: clientIp(request) }),
  });

  return jsonResponse(200, { intervalSec: cfg.presenceIntervalSec });
}

async function presenceCounts(env) {
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global-presence"));
  const res = await stub.fetch("https://presence/counts");
  return res.json().catch(() => ({ online: 0, android: 0, pc: 0, updatedAt: Date.now() }));
}

async function directoryCount(env) {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global-directory"));
  const res = await stub.fetch("https://directory/count");
  const data = await res.json().catch(() => ({ count: 0 }));
  return data.count ?? 0;
}

// Geometry copied from the Go server, which copied shields' for-the-badge
// render byte for byte.
function liveBadge(online) {
  const value = String(online);
  const valueWidth = 8.25 * value.length + 24;
  const width = 124.25 + valueWidth;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="LISTENING NOW: ${value}"><title>LISTENING NOW: ${value}</title><g shape-rendering="crispEdges"><rect width="124.25" height="28" fill="#0d1117"/><rect x="124.25" width="${valueWidth}" height="28" fill="#fb4f67"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100"><text transform="scale(.1)" x="621.25" y="175" textLength="1002.5">LISTENING NOW</text><text transform="scale(.1)" x="${(124.25 + valueWidth / 2) * 10}" y="175" textLength="${82.5 * value.length}" font-weight="bold">${value}</text></g></svg>`;
  return new Response(svg, {
    status: 200,
    headers: {
      "access-control-allow-origin": "*",
      "content-type": "image/svg+xml;charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate, max-age=0",
    },
  });
}

async function inviteLanding(env, cfg, url, rawCode) {
  const code = normaliseCode(rawCode);
  const origin = cfg.publicOrigin || url.origin;

  let active = false;
  let memberCount = 0;
  let title = "";
  let artist = "";
  if (isValidCode(code)) {
    const stub = env.PARTY_ROOM.get(env.PARTY_ROOM.idFromName(`party:${code}`));
    const res = await stub.fetch("https://room/invite");
    if (res.ok) {
      const data = await res.json();
      active = data.exists === true;
      memberCount = data.memberCount ?? 0;
      title = data.currentSongTitle ?? "";
      artist = data.currentSongArtist ?? "";
    }
  }

  const deepLink = `orelacat://party/${encodeURIComponent(code)}?server=${encodeURIComponent(origin)}`;
  const intentUri = `intent://party/${encodeURIComponent(code)}?server=${encodeURIComponent(origin)}#Intent;scheme=orelacat;end`;

  const html = renderInvite({ active, code, deepLink, intentUri, memberCount, title, artist });
  return new Response(html, {
    status: !isValidCode(code) ? 400 : active ? 200 : 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInvite({ active, code, deepLink, intentUri, memberCount, title, artist }) {
  const nowPlaying = title
    ? `<div class="now-playing">🎵 ${esc(title)}${artist ? ` - ${esc(artist)}` : ""}</div>`
    : "";
  const body = active
    ? `<div class="badge"><span class="badge-dot"></span><span>Listen Together • ${memberCount} in party</span></div>
            <h1>Join the Music Party</h1>
            <p class="subtitle">Opening OrelaCat to sync playback in real time.</p>
            <div class="code-box">
                <div class="code-label">Party Code</div>
                <div class="code-val">${esc(code)}</div>
                ${nowPlaying}
            </div>
            <a id="joinBtn" href="${esc(intentUri)}" class="btn">Join Party in OrelaCat</a>
            <p class="footer-note">
                Didn’t open automatically? Tap the button above.<br>
                Don't have OrelaCat yet? <a href="https://linktr.ee/FahrillAS" target="_blank" rel="noopener">Get it here</a>.
            </p>
            <script>
                var intentUri = ${JSON.stringify(intentUri)};
                var deepLink = ${JSON.stringify(deepLink)};
                function launch() {
                    if (/Android/i.test(navigator.userAgent)) {
                        window.location.href = intentUri;
                    } else {
                        window.location.href = deepLink;
                    }
                }
                setTimeout(launch, 100);
            </script>`
    : `<div class="badge"><span class="badge-dot offline"></span><span>Party Inactive</span></div>
            <h1>Party Not Found</h1>
            <p class="subtitle">This party code has expired or does not exist on this server.</p>
            <div class="code-box">
                <div class="code-label">Party Code</div>
                <div class="code-val" style="color: #a1a1aa;">${esc(code)}</div>
            </div>
            <p class="footer-note">
                Please ask the host for a new invite link or check your server configuration.
            </p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OrelaCat Listen Together - Party ${esc(code)}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: #0b0b0e;
            color: #f3f3f7;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }
        .container {
            background: rgba(22, 22, 30, 0.85);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 28px;
            max-width: 440px;
            width: 100%;
            padding: 36px 28px;
            text-align: center;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(124, 77, 255, 0.1);
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(124, 77, 255, 0.15);
            color: #b388ff;
            font-size: 13px;
            font-weight: 600;
            padding: 6px 14px;
            border-radius: 9999px;
            margin-bottom: 20px;
            letter-spacing: 0.5px;
        }
        .badge-dot {
            width: 8px;
            height: 8px;
            background: #00e676;
            border-radius: 50%;
            box-shadow: 0 0 8px #00e676;
        }
        .badge-dot.offline {
            background: #ff5252;
            box-shadow: 0 0 8px #ff5252;
        }
        h1 {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 8px;
            letter-spacing: -0.5px;
        }
        .subtitle {
            color: #9e9ea7;
            font-size: 15px;
            line-height: 1.5;
            margin-bottom: 28px;
        }
        .code-box {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 18px;
            padding: 16px 20px;
            margin-bottom: 28px;
        }
        .code-label {
            font-size: 12px;
            color: #71717a;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-bottom: 6px;
        }
        .code-val {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 32px;
            font-weight: 800;
            letter-spacing: 6px;
            color: #ffffff;
        }
        .now-playing {
            font-size: 14px;
            color: #d1d1d6;
            margin-top: 10px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .btn {
            display: block;
            width: 100%;
            padding: 16px 24px;
            background: linear-gradient(135deg, #7c4dff 0%, #3d5afe 100%);
            color: #ffffff;
            font-size: 16px;
            font-weight: 600;
            text-decoration: none;
            border-radius: 16px;
            border: none;
            cursor: pointer;
            transition: transform 0.15s ease, opacity 0.15s ease;
            box-shadow: 0 8px 24px rgba(124, 77, 255, 0.35);
        }
        .btn:hover {
            transform: translateY(-1px);
            opacity: 0.95;
        }
        .btn:active {
            transform: scale(0.98);
        }
        .footer-note {
            margin-top: 24px;
            font-size: 13px;
            color: #71717a;
            line-height: 1.5;
        }
        .footer-note a {
            color: #b388ff;
            text-decoration: none;
        }
        .footer-note a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        ${body}
    </div>
</body>
</html>`;
}
