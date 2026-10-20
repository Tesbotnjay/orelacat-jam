// Port of D:\vsongs\orelacat-jam\presence\presence.go
//
// Counts how many app installs are open right now. One Durable Object holds
// every install's last heartbeat; a 15-second alarm sweeps the expired ones and
// publishes the counts, exactly like the Go tracker's startPresenceSweeper.
// Reads take the published counts, never the full table.

import { config } from "./config.js";

const SWEEP_MS = 15 * 1000;

export class PresenceDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cfg = config(env);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ping" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.id !== "string") return new Response("bad request", { status: 400 });
      const key = `p:${body.id.toLowerCase()}`;
      const existing = await this.ctx.storage.get(key);
      if (!existing) {
        const size = await this.size();
        if (this.cfg.presenceMaxEntries > 0 && size >= this.cfg.presenceMaxEntries) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (body.open === false) {
        await this.ctx.storage.delete(key);
      } else {
        await this.ctx.storage.put(key, {
          lastMs: Date.now(),
          platform: body.platform === "pc" ? "pc" : "android",
        });
      }
      await this.ensureAlarm();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/counts") {
      const counts = (await this.ctx.storage.get("counts")) || {
        online: 0,
        android: 0,
        pc: 0,
        updatedAt: 0,
      };
      return new Response(JSON.stringify(counts), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  async size() {
    const map = await this.ctx.storage.list({ prefix: "p:", limit: this.cfg.presenceMaxEntries + 1 });
    return map.size;
  }

  async ensureAlarm() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async alarm() {
    const now = Date.now();
    const windowMs = (this.cfg.presenceIntervalSec + this.cfg.presenceGraceSec) * 1000;
    const cutoff = now - windowMs;

    const all = await this.ctx.storage.list({ prefix: "p:" });
    const expired = [];
    const counts = { online: 0, android: 0, pc: 0, updatedAt: now };
    for (const [key, entry] of all) {
      if (!entry || entry.lastMs < cutoff) {
        expired.push(key);
        continue;
      }
      if (entry.platform === "pc") counts.pc += 1;
      else counts.android += 1;
    }
    counts.online = counts.android + counts.pc;

    if (expired.length > 0) await this.ctx.storage.delete(expired);
    await this.ctx.storage.put("counts", counts);

    // Keep sweeping while anything is tracked, so a quiet server stops paying
    // for alarms but resumes as soon as an app pings again.
    if (all.size - expired.length > 0) {
      await this.ctx.storage.setAlarm(now + SWEEP_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
