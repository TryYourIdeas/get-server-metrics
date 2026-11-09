# All-servers overview and editable alert thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "All servers" overview to the dashboard, and let the alert thresholds be edited from the dashboard (one default set for every server plus optional per-server overrides) and pushed live to the agents over MQTT.

**Architecture:** Thresholds are stored in Postgres (two small tables). The event monitor, which already owns all writes and the MQTT connection, validates and saves them and publishes each host's *effective* values as a retained `computer-usage/<host>/config` message. Agents subscribe to their own config topic and update their running evaluator without losing alert state. The dashboard reads from the database and sends writes to the event monitor over HTTP, as it already does for "check now".

**Tech Stack:** TypeScript, Nuxt 4 / Vue 3 (dashboard), Node + tsx (agent, event monitor), mqtt.js, Drizzle ORM + Postgres, Mosquitto, Vitest (agent tests use the in-process Aedes broker; root tests need the compose Postgres).

**Spec:** `docs/superpowers/specs/2026-11-09-all-servers-and-editable-thresholds-design.md`

## Global Constraints

- Threshold keys, always these four: `cpuPercent`, `cpuConsecutive`, `memoryPercent`, `diskPercent`. Built-in defaults: 90 / 3 / 90 / 90.
- Valid ranges (same as the agent's env parsing): percentages are numbers from 1 to 100 inclusive; `cpuConsecutive` is a safe integer ≥ 1.
- Config topic: `computer-usage/<host>/config`, published by the event monitor with `retain: true`, QoS 1. Payload: JSON object with the four effective values.
- Broker ACL: user `app` gets `topic write computer-usage/+/config`; agents get `pattern read computer-usage/%u/config` and nothing else new. The broker must be restarted after upgrading; say so in the docs.
- The agent's environment thresholds stay the starting values. Until a config message arrives, and when no thresholds were ever saved, agents behave exactly as today.
- The monitor publishes nothing on its own while no defaults and no overrides have ever been saved; saving or removing anything always publishes the affected hosts' effective values (built-in values when no defaults are saved).
- `agent/src/protocol.ts` must stay dependency-free (the dashboard and event monitor import it).
- The overview updates from the existing `/api/stream` messages. No new polling loop.
- The dashboard has no login; say so in the docs. New event-monitor routes use the existing bearer-token check (they sit behind it automatically).
- Commit messages follow the repo style (`feat:`, `docs:`, `test:`); each task ends with a commit on branch `feature/all-servers-and-editable-thresholds`.
- Tests: agent `cd agent && npx vitest run test/<file>`; root `npx vitest run tests/<file>` (database tests need `docker compose up -d postgres` running, port 5433, database `computer-usage-test`); event monitor `npm run monitor:typecheck`; agent `npm --workspace agent run typecheck`.

## Review Focus

1. A retained config must never go stale: after the last override is removed and no defaults were ever saved, the agent must receive the built-in values, not keep the old override (Task 5).
2. Changing a threshold on an agent that is currently alerting: no duplicate `alert`, and the `ok` must still be emitted (Task 2).
3. Garbage on the config topic — non-JSON, wrong types (`"70"`), out of range (`150`, `0`), `cpuConsecutive: 1.5`, extra fields — is ignored by the agent, which keeps its previous values (Tasks 1, 3).
4. Host ids that would be MQTT wildcards or extra topic levels (`a/#`, `+`, `a/b`, `..`, 65 characters) never reach a topic or a database row through the new routes (Tasks 5, 6).
5. Overview edge cases: a machine with no reading yet, with no disks, and an offline machine that still has an old unresolved alert (Task 7). Also a threshold form with every override field blank (Task 8).

---

### Task 1: Shared threshold types, validation and the `config` topic

**Files:**
- Modify: `agent/src/protocol.ts`, `agent/src/thresholds.ts`
- Test: `agent/test/protocol.test.ts`

**Interfaces:**
- Produces (all exported from `agent/src/protocol.ts`, re-exported by `agent/src/index.ts` and `agent/protocol`):
  - `interface Thresholds { cpuPercent: number; cpuConsecutive: number; memoryPercent: number; diskPercent: number }`
  - `const DEFAULT_THRESHOLDS: Thresholds` (90/3/90/90) — moved here; `thresholds.ts` re-exports `DEFAULT_THRESHOLDS` and `Thresholds` so existing imports keep working.
  - `const THRESHOLD_KEYS: readonly (keyof Thresholds)[]`
  - `const THRESHOLD_LIMITS: Record<keyof Thresholds, { min: number; max?: number; integer: boolean }>`
  - `isValidThreshold(key: keyof Thresholds, v: unknown): v is number`
  - `parseThresholds(v: unknown): Thresholds | null` — all four keys required and valid; extra keys ignored.
  - `parseThresholdOverride(v: unknown): Partial<Thresholds> | null` — plain object with at least one key, only known keys, each valid.
  - `resolveThresholds(defaults: Thresholds, override?: Partial<Thresholds> | null): Thresholds`
  - `MESSAGE_TYPES` gains `'config'`.

- [ ] **Step 1: Write failing tests** in `agent/test/protocol.test.ts`:
  - `parseTopic accepts the config topic`: `parseTopic('computer-usage/h1/config')` → `{ host: 'h1', type: 'config' }`.
  - `parseThresholds accepts a full valid set` (90/3/90/90 and `{cpuPercent: 1, cpuConsecutive: 1, memoryPercent: 100, diskPercent: 50.5}`) and ignores extra keys.
  - `parseThresholds rejects` each of: missing key, `cpuPercent: 0`, `101`, `"70"`, `NaN`/`null`, `cpuConsecutive: 0`, `1.5`, a non-object, an array.
  - `parseThresholdOverride accepts any non-empty subset` (`{ diskPercent: 80 }`), `rejects {}`, unknown keys (`{ diskPercent: 80, foo: 1 }`), and invalid values.
  - `resolveThresholds` fills gaps from the defaults, ignores an absent/`null` override, and does not mutate its inputs.
- [ ] **Step 2:** Run `cd agent && npx vitest run test/protocol.test.ts` — expect failures (missing exports).
- [ ] **Step 3:** Implement the above in `protocol.ts`; limits: percentages `min 1, max 100, integer false`; `cpuConsecutive` `min 1, integer true` (use `Number.isSafeInteger`). `thresholds.ts` imports the type/const from `./protocol` and re-exports them (if TypeScript reports an ambiguous `export *` in `agent/src/index.ts`, drop the re-export from `thresholds.ts` and point its importers at `./protocol` instead).
- [ ] **Step 4:** Run `cd agent && npx vitest run && npm --workspace agent run typecheck` from the right folders — expect all pass.
- [ ] **Step 5: Commit** `feat: shared threshold types, validation and config topic`.

### Task 2: Evaluator accepts new thresholds and keeps its state

**Files:**
- Modify: `agent/src/thresholds.ts`
- Test: `agent/test/thresholds.test.ts`

**Interfaces:**
- Consumes: `Thresholds` from Task 1.
- Produces: `type ThresholdEvaluator = ((r: Reading) => UsageEvent[]) & { setThresholds(t: Thresholds): void }`; `createThresholdEvaluator(t: Thresholds): ThresholdEvaluator`. Existing call sites keep working (still callable with a reading).

- [ ] **Step 1: Write failing tests** (use the file's existing `r()`/`ev()` helpers; add `ev()` variants that return the evaluator so `setThresholds` can be called):
  - `a threshold change keeps an active alert: no duplicate alert` — memory 95 alerts at 90; `setThresholds({...DEFAULT_THRESHOLDS, memoryPercent: 80})`; the same reading returns `[]`.
  - `a raised threshold clears an alert with an ok that reports the new threshold` — after the alert, `memoryPercent: 99`, reading 95 → one `{ kind: 'memory', state: 'ok', threshold: 99 }`.
  - `a lowered threshold alerts on the next check` — reading 85 gives `[]`; `memoryPercent: 80`; 85 → `{ kind: 'memory', state: 'alert', threshold: 80 }`.
  - `the same holds for a disk mount` (alert at 90, change to 99 → one `ok` with `mount: '/'`).
  - `a threshold change restarts the CPU streak` — cpu 95, 95 at default; `setThresholds({...DEFAULT_THRESHOLDS, cpuPercent: 50})`; then 95 → `[]`, 95 → `[]`, 95 → one cpu alert (needs 3 checks after the change).
- [ ] **Step 2:** Run `cd agent && npx vitest run test/thresholds.test.ts` — expect FAIL.
- [ ] **Step 3:** Make the closure's `t` mutable; `setThresholds` replaces it and resets only `cpuStreak` (alert flags stay). Return `Object.assign(fn, { setThresholds })`.
- [ ] **Step 4:** Run the agent suite and typecheck — all pass (existing threshold tests unchanged).
- [ ] **Step 5: Commit** `feat: threshold evaluator accepts new thresholds without losing alert state`.

### Task 3: Agent applies config messages

**Files:**
- Modify: `agent/src/agent.ts`
- Test: `agent/test/agent.test.ts`

**Interfaces:**
- Consumes: `parseThresholds`, `topic(host, 'config')`, `ThresholdEvaluator.setThresholds`.
- Produces: no new exports; behaviour: on connect the agent subscribes to `computer-usage/<hostId>/config` (QoS 1, together with its check topic); a valid message calls `evaluate.setThresholds` and logs `thresholds updated` at info level; an invalid one logs an error with a payload preview (max 200 chars) and changes nothing.

- [ ] **Step 1: Write failing tests** (extend the existing `observe`/`waitFor` helpers; publish with `client.publishAsync('computer-usage/h1/config', JSON.stringify(cfg), { qos: 1, retain: true })`; build agents with `config(url, { checkIntervalMs: 100 })`):
  - `applies a retained config that was published before it started`: retained memoryPercent 70 published first; agent whose collector returns `memUsed: 80` → an event `{ kind: 'memory', state: 'alert', threshold: 70 }` appears.
  - `applies a config received while running`: agent with `memUsed: 80` and default 90 produces no memory event for ~500 ms; publish the config; the alert appears.
  - `ignores invalid configs and keeps its thresholds`: publish `{"cpuPercent":150,"cpuConsecutive":3,"memoryPercent":70,"diskPercent":90}`, `{"cpuPercent":90,"cpuConsecutive":3,"memoryPercent":"70","diskPercent":90}`, and the text `not json`; collector `memUsed: 95` still alerts with `threshold: 90`; nothing throws.
  - `uses its environment thresholds when no config was received`: collector `memUsed: 95`, custom `thresholds` memoryPercent 95 → alert with `threshold: 95`.
- [ ] **Step 2:** Run `cd agent && npx vitest run test/agent.test.ts` — expect FAIL.
- [ ] **Step 3:** In `startAgent`: add `configTopic`; subscribe to `[checkTopic, configTopic]`; dispatch in the `message` handler by topic.
- [ ] **Step 4:** Run the agent suite and typecheck — all pass.
- [ ] **Step 5: Commit** `feat: agent applies threshold config received over MQTT`.

### Task 4: Database tables and repository functions

**Files:**
- Modify: `shared/server/db/schema.ts`, `shared/server/utils/repository.ts`
- Create: `shared/drizzle/<generated>.sql` (+ meta), `tests/repository-thresholds.test.ts`

**Interfaces:**
- Produces, in `shared/server/utils/repository.ts`:
  - `interface ThresholdSettings { defaults: Thresholds | null; overrides: Record<string, Partial<Thresholds>> }`
  - `interface OverviewEntry extends HostRow { current: Reading | null; events: UsageEvent[] }` (events newest first)
  - `repo.getThresholdSettings(): Promise<ThresholdSettings>` — `defaults` is `null` until saved.
  - `repo.saveDefaultThresholds(t: Thresholds): Promise<void>` (upsert of the single defaults row).
  - `repo.saveHostThresholds(hostId: string, o: Partial<Thresholds>): Promise<void>` — replaces the host's row; keys absent from `o` become null/unset.
  - `repo.deleteHostThresholds(hostId: string): Promise<boolean>` — true if a row existed.
  - `repo.getOverview(eventsPerHost = 50): Promise<OverviewEntry[]>` — every row of `hosts` (ordered by id), its latest reading (or `null`) and its recent events.
- Tables (`schema.ts`): `thresholdDefaults` (single row: id fixed at 1, four non-null threshold columns, `updatedAt`) and `hostThresholds` (`hostId` primary key, four nullable threshold columns, `updatedAt`; no foreign key to `hosts`).

- [ ] **Step 1: Write failing tests** in `tests/repository-thresholds.test.ts` (same setup as `tests/repository.test.ts`; truncate `samples, events, hosts, threshold_defaults, host_thresholds`):
  - `returns no defaults and no overrides before anything is saved`.
  - `saves the defaults and replaces them on a second save`.
  - `saves a partial override and returns only its values`, and `replaces an existing override instead of merging`.
  - `deleteHostThresholds returns true then false`.
  - `getOverview returns each host with its latest reading and events newest first`, and a host with no samples has `current: null, events: []`.
- [ ] **Step 2:** Run `npx vitest run tests/repository-thresholds.test.ts` — FAIL.
- [ ] **Step 3:** Add the tables, run `npm run db:generate`, commit the generated migration, implement the functions (`runMigrations` applies the migration on startup and in tests).
- [ ] **Step 4:** Run `npx vitest run tests/repository-thresholds.test.ts tests/repository.test.ts` — pass.
- [ ] **Step 5: Commit** `feat: store thresholds and add the overview query`.

### Task 5: Publishing thresholds from the event monitor

**Files:**
- Create: `shared/server/utils/threshold-publisher.ts`, `tests/threshold-publisher.test.ts`
- Modify: `shared/server/utils/ingest.ts` (+ `tests/ingest.test.ts`), `event-monitor/src/main.ts`

**Interfaces:**
- Consumes: `repo.getThresholdSettings`, `repo.listHosts`, `resolveThresholds`, `DEFAULT_THRESHOLDS`, `isValidHostId`.
- Produces:
  - `createThresholdPublisher(deps: { repo: Pick<Repo, 'getThresholdSettings' | 'listHosts'>; publish: (host: string, t: Thresholds) => Promise<void> }): { publishHost(hostId: string): Promise<void>; publishAll(): Promise<void>; onHostOnline(hostId: string): Promise<void> }`
    - effective values = `resolveThresholds(settings.defaults ?? DEFAULT_THRESHOLDS, settings.overrides[host])`.
    - `publishHost` always publishes, and rejects without publishing for an invalid host id; `publishAll` publishes to every listed host, logs (does not throw) when one publish fails and carries on; `onHostOnline` publishes only when `defaults !== null` or any override exists.
  - `createIngest` takes an optional `onHostOnline?: (host: string) => Promise<void> | void`, called after a `status` message with `state: 'online'`; its errors are logged with `logError` and never make ingest reject.
- Monitor HTTP routes (all return JSON; invalid body → `400 { error: string }`; host ids checked with `isValidHostId` → 400):
  - `PUT /thresholds` — body validated with `parseThresholds`; saves defaults; `publishAll()` in the background; `200 { defaults }`.
  - `PUT /hosts/:host/thresholds` — `parseThresholdOverride`; saves; `publishHost`; `200 { override, effective }`.
  - `DELETE /hosts/:host/thresholds` — deletes; `publishHost`; `200 { deleted, effective }`.
  - Bodies over 4 KB → 413. A failed background publish is logged, not returned.

- [ ] **Step 1: Write failing tests** with a fake repo and a `publish` spy:
  - Publisher: `publishHost uses the override over the defaults`; `publishHost sends the built-in values when nothing is saved` (focus 1); `publishAll sends the effective values to every known host`; `onHostOnline sends nothing when nothing was ever saved`; `onHostOnline sends the effective values once something is saved`; `publishHost rejects 'a/#', '+', 'a/b', '..' and a 65-char id without publishing` (focus 4); `publishAll keeps going when one publish fails`.
  - Ingest: `calls onHostOnline when a host reports online`; `does not call it for an offline status`; `a failing onHostOnline does not make ingest reject`.
- [ ] **Step 2:** Run `npx vitest run tests/threshold-publisher.test.ts tests/ingest.test.ts` — FAIL.
- [ ] **Step 3:** Implement the publisher and the ingest hook. In `main.ts` create the publisher with `publish: (host, t) => client.publishAsync(topic(host, 'config'), JSON.stringify(t), { qos: 1, retain: true })`, pass `onHostOnline: publisher.onHostOnline` to `createIngest`, and add the three routes with a small JSON-body reader.
- [ ] **Step 4:** Run `npx vitest run` and `npm run monitor:typecheck` — pass.
- [ ] **Step 5: Commit** `feat: event monitor stores and publishes thresholds`.

### Task 6: Broker rules and dashboard server API

**Files:**
- Modify: `docker/mosquitto/acl`, `dashboard/server/utils/event-monitor.ts`
- Create: `dashboard/server/api/thresholds.get.ts`, `dashboard/server/api/thresholds.put.ts`, `dashboard/server/api/hosts/[host]/thresholds.put.ts`, `dashboard/server/api/hosts/[host]/thresholds.delete.ts`, `dashboard/server/api/overview.get.ts`

**Interfaces:**
- Produces:
  - ACL lines from Global Constraints, with a comment explaining them.
  - `forwardToMonitor(path: string, init: { method: 'PUT' | 'DELETE'; body?: unknown }): Promise<unknown>` in `event-monitor.ts`: calls the monitor with the existing URL/token helpers and a 5 s timeout; a monitor `400` becomes `createError({ statusCode: 400, statusMessage: <monitor's error text> })`; other failures become `502 'Event monitor is unavailable'`.
  - `GET /api/thresholds` → `{ defaults: Thresholds, overrides: Record<string, Partial<Thresholds>>, builtIn: Thresholds }` (`defaults` is the stored set, or `builtIn` when none was saved).
  - `GET /api/overview` → `{ entries: OverviewEntry[] }`.
  - `PUT /api/thresholds`, `PUT /api/hosts/:host/thresholds`, `DELETE /api/hosts/:host/thresholds`: validate the host id with `isValidHostId` (400 `invalid host id`) and forward the JSON body.

- [ ] **Step 1:** There is no harness for Nitro handlers; keep them thin. Implement the files above.
- [ ] **Step 2:** Run `npm run build` — expect it to complete.
- [ ] **Step 3:** With the compose stack up (Postgres + broker + monitor + dashboard): `curl localhost:3000/api/thresholds` returns the built-in values; `curl -X PUT localhost:3000/api/thresholds -H 'content-type: application/json' -d '{"cpuPercent":150,"cpuConsecutive":3,"memoryPercent":90,"diskPercent":90}'` returns 400 with a readable message; `curl 'localhost:3000/api/overview'` lists hosts.
- [ ] **Step 4: Commit** `feat: threshold and overview API in the dashboard, broker rules for the config topic`.

### Task 7: All servers view

**Files:**
- Create: `dashboard/app/utils/overview.ts`, `dashboard/app/components/ServerCard.vue`, `tests/overview.test.ts`
- Modify: `dashboard/app/pages/index.vue`

**Interfaces:**
- Consumes: `OverviewEntry` (Task 4), `activeAlerts`/`isStale`/`describeAlert` from `dashboard/app/utils/alerts.ts`.
- Produces in `overview.ts`:
  - `type BusMessage` (moved here from `index.vue`, unchanged shape).
  - `type CardState = 'alert' | 'offline' | 'stale' | 'waiting' | 'ok'`
  - `cardState(e: OverviewEntry, now: number, staleAfterMs: number): CardState` — `offline` if `!online`; else `stale` if `isStale(lastSeen…)`; else `alert` if `activeAlerts(e.events).length > 0`; else `waiting` if `current === null`; else `ok`.
  - `sortEntries(entries: OverviewEntry[], now: number, staleAfterMs: number): OverviewEntry[]` — rank `alert` 0, `offline`/`stale` 1, `waiting`/`ok` 2; ties by `hostId`; returns a new array.
  - `applyStreamMessage(entries: OverviewEntry[], msg: BusMessage, nowIso: string): OverviewEntry[]` — pure. `reading` sets `current`, `online: true`, `lastSeen: nowIso`; `event` prepends the event (keep at most 50) and marks online; `status` sets `online` and `lastSeen`; an unknown host, `broker` and `ping` return the same array instance.
- `ServerCard.vue`: props `{ entry: OverviewEntry; state: CardState }`, emits `select(hostId: string)`; shows host id, state label, CPU/memory/each disk with the existing `GaugeBar`, active alerts via `describeAlert`, and "Waiting for the first reading" when `current` is null.
- `index.vue`: the machine selector gets an "All servers" entry, first and selected by default; selecting a card or a machine shows the existing detail view unchanged. The detail fetches must not run with the "all" value (never send an invalid host id). The overview comes from `/api/overview`, is updated through `applyStreamMessage` in the existing stream handler, and is refreshed on stream reconnect like the other data. A "Triggers" link goes to `/triggers`.

- [ ] **Step 1: Write failing tests** in `tests/overview.test.ts`: `cardState` for each of the five states including `offline machine with an old unresolved alert is offline` and `a machine with no disks is ok`; `sortEntries` puts alerting first, then offline/stale, then the rest, ties by id, and does not mutate; `applyStreamMessage` cases for reading, event (cap of 50, newest first), status, unknown host returns the same array, and does not mutate the input.
- [ ] **Step 2:** Run `npx vitest run tests/overview.test.ts` — FAIL.
- [ ] **Step 3:** Implement `overview.ts`, then the component and the page changes.
- [ ] **Step 4:** Run `npx vitest run tests/overview.test.ts tests/alerts.test.ts` and `npm run build` — pass.
- [ ] **Step 5: Commit** `feat: all-servers overview in the dashboard`.

### Task 8: Triggers page

**Files:**
- Create: `dashboard/app/utils/thresholds-form.ts`, `dashboard/app/pages/triggers.vue`, `tests/thresholds-form.test.ts`

**Interfaces:**
- Consumes: `THRESHOLD_KEYS`, `THRESHOLD_LIMITS`, `isValidThreshold`, `resolveThresholds`, `Thresholds` from `agent/protocol`.
- Produces in `thresholds-form.ts`:
  - `type ThresholdFields = Record<keyof Thresholds, string>`
  - `type FormResult<T> = { ok: true; value: T } | { ok: false; errors: Partial<Record<keyof Thresholds, string>> }`
  - `fieldsFrom(t: Partial<Thresholds> | null | undefined): ThresholdFields` (missing → `''`)
  - `parseDefaultsForm(f: ThresholdFields): FormResult<Thresholds>` — all four required.
  - `parseOverrideForm(f: ThresholdFields): FormResult<Partial<Thresholds> | null>` — blank fields are omitted; every field blank → `{ ok: true, value: null }` (meaning "use defaults").
  - Fields are trimmed; error texts: `Enter a number between 1 and 100` (percentages) and `Enter a whole number, 1 or more` (consecutive checks).
- `triggers.vue` (`/triggers`): a form for the defaults (`PUT /api/thresholds`); a table of machines (from `/api/hosts`) with their effective values and an Edit action opening an override form whose placeholders are the current default values; Save sends `PUT /api/hosts/:host/thresholds`, or `DELETE` when `parseOverrideForm` returns `null`; a "Use defaults" button always sends `DELETE`; shows success and the server's error message; refetches after each save; a link back to the dashboard.

- [ ] **Step 1: Write failing tests** in `tests/thresholds-form.test.ts`: blank defaults field → error on that key; `abc`, `0`, `101`, `1.5` (consecutive) → errors; a valid set → typed numbers; `' 80 '` trims; override with some blanks → only filled keys; `override with every field blank returns null` (focus 5); `fieldsFrom` round-trips numbers to strings.
- [ ] **Step 2:** Run `npx vitest run tests/thresholds-form.test.ts` — FAIL.
- [ ] **Step 3:** Implement the util, then the page.
- [ ] **Step 4:** Run `npx vitest run` (full root suite) and `npm run build` — pass.
- [ ] **Step 5: Commit** `feat: triggers page to edit default and per-server thresholds`.

### Task 9: End-to-end checks in the test stack, docs

**Files:**
- Modify: `docker/test-servers/run.sh`, `docker/test-servers/HOW-TO-RUN.md`, `docs/user-guides/config.md`, `docs/user-guides/manual.md`, `docs/user-guides/features.md`, `docs/pending-tasks.md`

**Interfaces:**
- `run.sh verify` (inside the block that already runs only when `SKIP_APPS != 1`) gains a "Checking threshold changes" section, each failure sets `failed=1` and prints `FAIL …`:
  1. `PUT http://localhost:$DASHBOARD_PORT/api/hosts/test-debian12/thresholds` with `{"diskPercent":1}`; within 30 s the database has an `events` row for `test-debian12` with `kind='disk'` and `state='alert'`.
  2. `DELETE` the same override; within 30 s an `ok` disk event for `test-debian12` exists.
  3. ACL: as user `test-alpine` (password `$TEST_AGENT_PASSWORD`, via `mosquitto_pub` in the broker container) publish a retained `{"cpuPercent":5,"cpuConsecutive":3,"memoryPercent":90,"diskPercent":90}` to both `computer-usage/test-alpine/config` and `computer-usage/test-debian12/config`; as user `app` read `computer-usage/+/config` for 3 s; FAIL if any message has `"cpuPercent":5`, and in that case clear the forged retained messages as `app`.
- `down` also deletes `host_thresholds` rows `where host_id like 'test-%'`.

- [ ] **Step 1:** Implement the `run.sh` additions; `bash -n docker/test-servers/run.sh`.
- [ ] **Step 2:** Update the docs: `config.md` (the `config` topic, the ACL lines, restart the broker after upgrading, defaults vs overrides, the dashboard has no login); `manual.md` (All servers view; how to change defaults and a server's override, with a mermaid sequence diagram dashboard → monitor → broker → agent); `features.md`; `HOW-TO-RUN.md` (the new checks and their output lines); in `pending-tasks.md` delete "5. Central threshold configuration" and renumber the later items.
- [ ] **Step 3:** Run the complete suites: `npx vitest run` (root, Postgres up) and `cd agent && npx vitest run`, plus both typechecks — all pass.
- [ ] **Step 4:** Run the full test stack (`export DOCKER_CONTEXT=default APP_PASSWORD=… TEST_AGENT_PASSWORD=…; docker/test-servers/run.sh`) — every line says `ok`, including the new threshold checks; then open the dashboard and confirm the All servers grid and `/triggers` by hand.
- [ ] **Step 5: Commit** `feat: end-to-end threshold checks in the test stack and user docs`.
