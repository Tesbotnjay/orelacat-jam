// Port of the service-wide room ceiling in party.PartyStore.CreateWithLimits.
//
// The Go store kept every party in one map, so it could refuse creation once
// MaxParties rooms existed. Parties now live in separate Durable Objects that
// cannot see each other, so this object keeps the register: which codes are in
// use, and when each was created. Codes are pruned once they pass the party's
// absolute maximum age, which is when the room itself expires them too.

import { config } from "./config.js";

const SWEEP_MS = 60 * 1000;

export class DirectoryDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cfg = config(env);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/reserve" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const code = body && typeof body.code === "string" ? body.code : "";
      if (!code) return json(422, { error: "invalid_code", message: "code is required" });

      await this.prune();
      const codes = (await this.ctx.storage.get("codes")) || {};
      if (codes[code]) return json(409, { error: "already_exists", message: "Code already reserved" });

      if (this.cfg.maxParties > 0 && Object.keys(codes).length >= this.cfg.maxParties) {
        return json(503, {
          error: "server_full",
          message: "The party server is busy. Please try again in a few minutes.",
        });
      }

      codes[code] = Date.now();
      await this.ctx.storage.put("codes", codes);
      await this.ensureAlarm();
      return json(201, { ok: true, code });
    }

    if (url.pathname === "/release" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const code = body && typeof body.code === "string" ? body.code : "";
      const codes = (await this.ctx.storage.get("codes")) || {};
      if (code && codes[code]) {
        delete codes[code];
        await this.ctx.storage.put("codes", codes);
      }
      return json(200, { ok: true });
    }

    if (url.pathname === "/count") {
      await this.prune();
      const codes = (await this.ctx.storage.get("codes")) || {};
      return json(200, { count: Object.keys(codes).length });
    }

    return new Response("not found", { status: 404 });
  }

  async prune() {
    const codes = (await this.ctx.storage.get("codes")) || {};
    const now = Date.now();
    let changed = false;
    for (const [code, createdAt] of Object.entries(codes)) {
      if (now - createdAt > this.cfg.partyMaxAgeMs) {
        delete codes[code];
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put("codes", codes);
  }

  async ensureAlarm() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async alarm() {
    await this.prune();
    const codes = (await this.ctx.storage.get("codes")) || {};
    if (Object.keys(codes).length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
