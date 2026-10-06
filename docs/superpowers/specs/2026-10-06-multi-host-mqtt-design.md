# Multi-host monitoring over MQTT — design

Date: 2026-10-06
Status: Draft, awaiting review
Covers pending tasks 4 (multiple machines), 5 (alerting) and 7 (sampling stops while the app is down).

## Intent

Monitor several computers from one dashboard without the database growing quickly. Machines report over MQTT. The app updates when something happens (low memory, low disk, high CPU) and when the user clicks **Check now**, instead of storing a reading from every machine every minute.

## Decisions

| Topic | Decision |
|---|---|
| Transport | MQTT, Mosquitto broker added to `docker-compose.yml` |
| Reporting | Heartbeat reading every 5 min (`HEARTBEAT_INTERVAL_MS`, default 300000) plus an immediate event when a threshold state changes |
| Thresholds | Evaluated on each agent from env vars; central configuration is a pending task |
| Alerting | Merged into this design (task 5): events are the alerts |
| Agent | Standalone TypeScript package `lib/computer-usage-agent/`, runs on every machine including the central one |
| Local machine | In-process sampler (ADR 0006) is removed; the central machine runs the agent like any other |
| App ingest | MQTT subscriber in a Nitro plugin; browsers updated through Server-Sent Events (approach A) |
| Network | Trusted network (LAN/VPN). Broker requires username/password per agent and an ACL limiting each agent to `computer-usage/<host>/#`. TLS is a pending task |
| Fast updates | The 5 s polling added earlier is removed. Updates arrive on heartbeat, on events and on Check now |

## Components

### Agent (`lib/computer-usage-agent/`)
- Collector (reuses the `systeminformation` logic from the app), threshold state machine, MQTT client, CLI entry point.
- Env: `HOST_ID`, `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `HEARTBEAT_INTERVAL_MS`, `CPU_THRESHOLD_PERCENT` (90), `CPU_CONSECUTIVE_CHECKS` (3), `MEMORY_THRESHOLD_PERCENT` (90), `DISK_THRESHOLD_PERCENT` (90), `NUXT_ADD_DEBUG_LOGS`.
- Checks thresholds on its own short interval (default 20 s) so events do not wait for the heartbeat. Publishes an event only when a metric's state changes (alert or ok). CPU needs 3 consecutive checks above the threshold; memory and disk alert on the first. Disk state is tracked per mount.
- Connects with a persistent session and a last-will `status: offline` message. Publishes `status: online` (retained) on connect.
- Offline queue held in memory, capped (default 1000 messages, newest kept), flushed on reconnect.
- A failed collection is logged and skipped.

### Broker
- Mosquitto in compose, password file and ACL. Each agent may publish only under `computer-usage/<its host>/` and subscribe only to its own `check` topic. Only the app user may subscribe to `computer-usage/#` and publish to `.../check`.

### App
- Nitro ingest plugin replaces `server/plugins/sampler.ts`. It subscribes to heartbeat, event, reading and status topics, validates and stores them, and publishes changes to an in-process event bus.
- `GET /api/stream` (SSE) streams readings, events and host online/offline changes from that bus to open dashboards.
- `POST /api/hosts/<host>/check` publishes to `computer-usage/<host>/check`.
- `GET /api/hosts` lists hosts with online state and last seen.
- `GET /api/metrics/history` gains a `host` parameter (default: first host). `GET /api/metrics/current` returns the host's latest reading from the database instead of collecting locally.
- Ingest retention (ADR 0007) is kept and also prunes `events`.

## Topics and payloads

| Topic | Direction | Payload | QoS |
|---|---|---|---|
| `computer-usage/<host>/heartbeat` | agent → app | reading | 1 |
| `computer-usage/<host>/event` | agent → app | `{ kind: "cpu"\|"memory"\|"disk", state: "alert"\|"ok", value, threshold, mount?, ts }` | 1 |
| `computer-usage/<host>/check` | app → agent | `{ requestId }` | 1 |
| `computer-usage/<host>/reading` | agent → app | reading plus `requestId` | 1 |
| `computer-usage/<host>/status` | agent → app | `{ state: "online"\|"offline" }`, retained | 1 |

A reading is `{ ts, cpuPercent, memUsed, memTotal, disks: [{ mount, used, total }] }`. The host always comes from the topic, never from the payload.

## Data model

- `samples`: add `host_id text not null` and a unique key on `(host_id, ts)`; existing rows are backfilled with `local`. Inserts use `ON CONFLICT DO NOTHING`, because QoS 1 can deliver a message twice. Replace the `ts` index with `(host_id, ts)`.
- `events`: `id`, `host_id`, `ts`, `kind`, `state`, `value`, `threshold`, `mount` (nullable), indexed by `(host_id, ts)`.
- `hosts`: `host_id` (primary key), `online`, `last_seen`.
- Replies to `check` are forwarded to browsers but not stored.

## Dashboard

- Host picker in the header. Gauges and charts show the selected host.
- Alert banner when an `event` with state `alert` arrives, cleared by the matching `ok`. Recent events listed under the charts.
- **Check now** button for the selected host. While waiting, the button is disabled with a short timeout message if no reply arrives (default 10 s).
- Host shown as stale when no message has arrived for 2 heartbeat intervals. "MQTT disconnected" banner when the app loses the broker.
- The 5 s polling is removed. The live-point merge from `app/utils/series.ts` stays and is fed by Check now readings.

## Failure handling

- Agent reconnects with backoff and flushes its capped offline queue.
- App reconnects automatically and logs connect, disconnect and subscribe errors. Persistent sessions with QoS 1 let the broker hold messages while the app is down.
- Invalid payloads are logged with topic and a truncated payload, then dropped. Ingest never throws out of the message handler.
- Logging follows the repo convention: errors always, tracing behind `NUXT_ADD_DEBUG_LOGS`.

## Testing

- Unit (no Docker): threshold state machine, payload validation, topic parsing, ingest handler with a fake MQTT client, offline queue cap.
- Integration (needs Docker): repository tests for `host_id`, the unique key and event retention; one broker-based test covering agent → app → database.

## Documentation and conventions

- ADR: MQTT transport and event-driven updates (supersedes parts of ADR 0006). ADR: the agent as a shared `lib/` package.
- Update `web/docs/architecture/` business, data, application and technology diagrams.
- Update `docs/user-guides/config.md`, `manual.md` (with a mermaid sequence diagram for events and Check now) and `features.md`.
- Pending tasks: remove 4, 5 and 7. Add central threshold configuration, broker TLS, and a viewer-driven live mode.

## Implementation stages

1. Schema and ingest: migration, repository, MQTT subscriber, SSE, Mosquitto in compose.
2. Agent package: collector, thresholds, MQTT client, CLI, offline queue.
3. Dashboard: host picker, alerts, Check now, stale and disconnected states, removal of 5 s polling.

## Out of scope

Central threshold configuration, broker TLS, a viewer-driven fast live mode, per-host retention, and downsampling (task 2).
