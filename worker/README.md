# OrelaCat Listen Together — Cloudflare Workers

The Go server in this repository is the reference implementation. This
directory is the same protocol, ported to Cloudflare Workers so it can run on a
free, permanent `*.workers.dev` URL with no payment card.

## Layout

| File | Ported from |
| --- | --- |
| `src/config.js` | `config/config.go` |
| `src/party.js` | `party/party.go`, `protocol/protocol.go`, `codes/codes.go` |
| `src/room.js` | `hub/hub.go` + the party half of `main.go` |
| `src/worker.js` | `main.go` (routing, CORS, presence, badge, invite page) |
| `src/presence.js` | `presence/presence.go` |
| `src/directory.js` | `PartyStore.CreateWithLimits` room ceiling |

## What maps to what

- **One party = one Durable Object.** The Go server kept parties in a process
  map behind a mutex; a DO is single-threaded and durable, so the mutex became
  unnecessary and the party survives eviction.
- **Sockets use the hibernation API.** That is what keeps a party alive on the
  free plan: the DO sleeps between messages instead of billing duration.
- **The state heartbeat is a DO alarm**, re-armed every `JAM_STATE_HEARTBEAT_MS`,
  reproducing the Go ticker that re-broadcast state every 5 seconds.
- **The open-app counter and the room ceiling are each one DO**, because they
  were each one mutex-guarded map in Go.

The wire protocol is byte-compatible with the Go server: same frame types,
action names, error codes, rate budgets and JSON field names, because the
Android client parses them.

## Deploy

```
wrangler deploy
```

`wrangler.toml` binds the three Durable Object classes and sets
`JAM_PUBLIC_ORIGIN`, which the invite page uses to build the `orelacat://` deep
link. Every other `JAM_*` variable from `config/config.go` is still read from
the environment with the same default.
