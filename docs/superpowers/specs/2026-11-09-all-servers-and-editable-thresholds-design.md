# All-servers overview and editable alert thresholds — design

Date: 2026-11-09
Status: Draft, awaiting review
Builds on: `2026-10-06-multi-host-mqtt-design.md` (which left "central configuration" as a pending task).

## Intent

Two changes to the dashboard, requested by the project owner:

1. **See all servers at once.** Today the dashboard shows one machine at a time, picked from a selector. An operator with several machines cannot tell at a glance which ones are healthy.
2. **Change the alert triggers from the dashboard.** Today the thresholds (CPU %, consecutive CPU checks, memory %, disk %) are environment variables read once by each agent at startup, so changing one means editing a file on that machine and restarting the agent.

## Goals

- An "All servers" view with one card per machine: online/offline/no-recent-data, current CPU, memory and disk gauges, and its active alerts. Clicking a card opens that machine's existing detail view. It updates live.
- One set of **default thresholds** that applies to every machine, plus an optional **override per machine**, both editable in the dashboard.
- Agents apply new thresholds without a restart, including agents that are offline when the change is made (they get it when they reconnect).
- Existing installs keep working with no configuration: until something is saved in the dashboard, agents use their own environment values exactly as today.

## Non-goals

- Editing anything else remotely (heartbeat interval, check interval, queue size stay environment variables on the agent).
- Authentication or roles on the dashboard. Like the rest of the dashboard it assumes a trusted network, so anyone who can open it can change thresholds. State this in the docs.
- Per-disk-mount thresholds (the disk threshold stays one value applied to every mount).
- Drawing threshold lines on the charts, email/chat notifications, history of threshold changes.

## Anti-goals (a failure even if it technically works)

- Changing a threshold must not make an agent forget its alert state: no duplicate "alert" events for something already alerting, and no lost "ok" (recovery) events.
- A dashboard or event-monitor outage must not stop agents from monitoring; they keep using the last values they received.
- An agent must never accept invalid values (out of range, wrong type); it keeps the previous ones and logs the problem.

## Design

### Data

Stored in the shared Postgres schema (`shared/server/db/schema.ts`, migrated by the event monitor like the other tables):

- **Defaults:** a single set of the four values. When nothing is stored the built-in defaults apply (90 / 3 / 90 / 90, from `agent/src/thresholds.ts`).
- **Per-host overrides:** for a host id, any subset of the four values. A missing value means "use the default". Deleting a host's override means "use defaults for everything".
- *(Builder's call: exact table layout; two small tables is the obvious shape.)*

Valid ranges are the ones the agent already enforces for its environment variables: percentages 1–100, consecutive checks an integer ≥ 1. One shared validation function, in the dependency-free `agent/protocol` module, is used by the event monitor (to reject bad input) and by the agent (to reject bad messages).

The **effective** thresholds for a host are the override values, with the defaults filling any gaps.

### Delivering the thresholds to agents

- New MQTT message type `config` on `computer-usage/<host>/config`: JSON with the four effective values. Published by the event monitor, **retained**, QoS 1, so a reconnecting or restarted agent receives the latest values immediately.
- The event monitor publishes: when defaults change (to every known host without a full override), when one host's override changes or is removed (to that host), and when a host is first seen or comes online while any threshold has ever been saved (so a brand-new agent gets the current values). It publishes nothing while no thresholds have ever been saved.
- Agent: subscribes to its own `config` topic, validates the message, and applies it to its running threshold evaluator. The evaluator must keep its current alert state when thresholds change (the next check naturally emits `ok` for something that no longer exceeds the new threshold, or `alert` for something that now does). Starting values still come from the environment.
- Broker rules (`docker/mosquitto/acl`): the `app` user may write `computer-usage/+/config`; each agent may read only `computer-usage/%u/config`. The broker needs a restart to pick this up; mention it in the docs.

### Event monitor and dashboard API

Writes belong to the event monitor (it already owns all database writes and the MQTT connection); the dashboard proxies to it the same way it does for "check now" and "delete logs", and reads settings straight from the database.

| Endpoint (dashboard) | Event monitor | Purpose |
|---|---|---|
| `GET /api/thresholds` | — (reads DB) | `{ defaults, overrides: { <host>: partial values }, builtIn }` |
| `PUT /api/thresholds` | `PUT /thresholds` | Replace the default set |
| `PUT /api/hosts/:host/thresholds` | `PUT /hosts/:host/thresholds` | Set a host's override (any subset of the four values) |
| `DELETE /api/hosts/:host/thresholds` | `DELETE /hosts/:host/thresholds` | Remove a host's override |
| `GET /api/overview` | — (reads DB) | One entry per host: id, online, lastSeen, latest reading (or null), active alerts |

Invalid input gets a 400 with a message the form can show; the event monitor's existing bearer-token check applies to the new routes. Document the endpoints in `docs/user-guides`.

### Dashboard

- **All servers view:** an "All servers" entry in the machine selector, shown first and selected by default (*my call*). Cards are sorted with alerting machines first, then offline/no-recent-data, then the rest. Live updates reuse the existing `/api/stream` messages; the overview must not need a separate polling loop. With no machines yet, show the existing "no machines have reported yet" message.
- **Triggers page** (`/triggers`, linked from the header): a form for the default values, and a table of machines showing each one's effective values with an edit action. Per-host fields left blank use the default (the default is shown as the placeholder), and a "Use defaults" button removes the override. Show save errors and success. Saving does not need to wait for agents to confirm.

### Test stack

`docker/test-servers/` should gain one end-to-end check: lower one test host's disk threshold through the API and see an `alert` event for that host appear (the alert host proves the path today with an environment value; this proves the dashboard path). Update `HOW-TO-RUN.md`.

## Acceptance criteria

1. With several machines reporting, the All servers view shows a card per machine with correct status, gauges and active alerts, ordered as described, and updates without a page reload when a reading, event or status change arrives.
2. Clicking a card shows that machine's detail view; the selector can return to All servers.
3. Saving new defaults changes the behaviour of every machine that has no override for that value; a machine with an override keeps its own value. Removing the override returns it to the default.
4. A threshold change reaches a running agent without restarting it, and reaches an agent that was offline when it was saved, once it reconnects.
5. Changing a threshold on an agent that is currently alerting produces no duplicate `alert` event and still produces an `ok` when the metric falls below the (new) threshold.
6. Invalid values (e.g. CPU 150, 0 consecutive checks, text) are rejected by the API with a 400 and by the agent if they arrive over MQTT; nothing changes.
7. With nothing saved in the dashboard, agents behave exactly as before (environment values, no `config` messages).
8. An agent cannot read or write another host's `config` topic or write its own (broker ACL).
9. Unit tests cover validation, effective-value resolution, the evaluator keeping state across a threshold change, and the new repository functions; the agent has a test against the in-process broker for receiving config. The documented test stack passes, including the new end-to-end check.
10. `docs/user-guides` (config, manual, features) and `docs/pending-tasks.md` are updated (the "central configuration" item is closed).

## Decided by the project owner

- One default set for all servers, with per-server overrides (confirmed).
- The overview is a grid of cards per server, each opening its detail view (confirmed).

## Left to the builder

- Table layout and migration details, file organisation, and the exact visual design of cards and forms (match the existing dashboard styling).
- How the evaluator exposes "update thresholds" while keeping state.
- Whether the config message carries a version/timestamp (not required).

## Risks to keep in mind

- The dashboard has no login, so threshold edits are open to anyone who can reach it (see non-goals).
- A very low threshold set by mistake makes machines alert constantly; the form should show the current values clearly and make "Use defaults" easy.
- The ACL change means existing deployments must restart the broker after upgrading, or agents will not receive config (they keep working with their environment values).
