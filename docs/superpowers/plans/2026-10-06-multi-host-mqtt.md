# Multi-host monitoring over MQTT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monitor several computers from one dashboard: agents on each machine report over MQTT (5-minute heartbeat plus threshold events), the app stores and streams them to browsers, and a "Check now" button fetches a fresh reading on demand.

**Architecture:** A new standalone package `lib/computer-usage-agent/` holds the collector, threshold state machine, MQTT agent runtime and the shared wire protocol. The Nuxt app drops its in-process sampler and instead subscribes to MQTT in a Nitro plugin, stores heartbeats/events in Postgres (tagged by `host_id`) and pushes updates to browsers over Server-Sent Events. Mosquitto is added to docker-compose with per-agent ACLs.

**Tech Stack:** TypeScript, Nuxt 4 / Nitro 2 (h3 1.15), Vue 3, Tailwind, Drizzle + Postgres 18, `mqtt` (client), Mosquitto 2 (broker), `aedes` (in-process broker for tests only), `systeminformation`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-multi-host-mqtt-design.md`

## Prerequisites

- The working tree currently has **uncommitted earlier work** (5 s live updates, chart axis labels, retention/pruning, retention ADR). Ask the user to commit it (or decide how to) **before Task 1**, so this feature's commits stay clean. Do not commit it yourself unasked.
- Docker is needed for the Postgres-backed tests and for Task 12's broker check. Where Docker is unavailable, those tests are written but cannot run; say so in the report instead of claiming they pass.
- Node 24 is installed (`node -v`), so `tsx --env-file-if-exists` is available.
- Two git repositories are involved: `web/computer-usage/` (the app) and the new `web/lib/computer-usage-agent/` (Task 1 runs `git init` there). Commit in the repo each task names.

## Global Constraints

- Topics: `computer-usage/<host>/{heartbeat|event|check|reading|status}`, all QoS 1; `status` is retained. The host is always taken from the topic, never from the payload.
- Host id regex: `^[A-Za-z0-9_.-]{1,64}$`, and not made only of dots.
- Heartbeat default 300000 ms (`HEARTBEAT_INTERVAL_MS`); threshold check default 20000 ms (`CHECK_INTERVAL_MS`); thresholds CPU 90% for 3 consecutive checks, memory 90%, disk 90% per mount (`>=` comparison); agent offline queue default 1000 messages, newest kept (`QUEUE_LIMIT`); Check now timeout 10 s; stale host = no message for 2 heartbeat intervals.
- Replies to `check` are never stored in the database.
- The old `local` host name backfills existing `samples` rows.
- Typescript only; Postgres 18 + Drizzle; Tailwind; logging per repo convention: errors always, tracing behind `NUXT_ADD_DEBUG_LOGS` (`true`/`1`); log prefix `[computer-usage]` in the app, `[computer-usage-agent]` in the agent.
- Git commit prefixes: `feat:`, `bugfix:`, `refactor:`, `config:`, `docs:`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Agent username must equal its `HOST_ID` (the broker ACL uses `%u`).
- Deviation from the spec, deliberate: replies to `check` are not queued while the agent is offline (a stale on-demand reply is useless); heartbeats and events are queued.

## Review Focus

Failure modes the spec implies that no obvious happy-path test would catch, most likely first. Each has a pinning test in the task named.

1. **Hostile or malformed host id** (`a/b`, `+`, `#`, empty, 65 chars, `..`) in a topic or in the `/api/hosts/<host>/check` URL must be rejected, not turned into a wildcard topic. Pinned in Task 1 (protocol) and Task 10 (API).
2. **Garbage or hostile payloads** (invalid JSON, negative sizes, CPU 250%, timestamp days in the future that would freeze the live chart) must be logged and dropped, never stored and never crash ingest. Pinned in Task 8.
3. **The same message delivered twice** (QoS 1 redelivery) must create one `samples` row and one event, and emit to browsers once. Pinned in Task 7 (DB) and Task 8.
4. **A disk that disappears while in alert** (USB removed) must emit an `ok` event so the banner clears, and a one-sample CPU spike must not alert. Pinned in Task 2.
5. **Pressing Check now repeatedly, or for a host that never answers** must hit a cooldown and a UI timeout, not pile up requests or hang the button. Pinned in Task 10; UI timeout in Task 11.

---

## Stage 1 — Shared package and agent

### Task 1: Create the `computer-usage-agent` package with the wire protocol

**Files:**
- Create: `lib/computer-usage-agent/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `lib/computer-usage-agent/src/protocol.ts`
- Test: `lib/computer-usage-agent/test/protocol.test.ts`

**Interfaces:**
- Produces (all exported from `src/protocol.ts`, dependency-free so the Nuxt app can import `computer-usage-agent/protocol`): `TOPIC_ROOT`, `MESSAGE_TYPES`, `MessageType`, `Reading`, `DiskReading`, `UsageEvent`, `EventKind`, `CheckRequest`, `CheckReply`, `StatusMessage`, `isValidHostId(v): v is string`, `topic(host, type): string`, `parseTopic(t): {host, type} | null`, `decodePayload(p: Uint8Array | string): unknown`, `parseReading`, `parseEvent`, `parseCheckRequest`, `parseCheckReply`, `parseStatus` (each takes `unknown`, returns the typed value or `null`).

- [ ] **Step 1: Scaffold the package**

```bash
mkdir -p /media/luis/data-luis/TYI/web/lib/computer-usage-agent/{src,test}
cd /media/luis/data-luis/TYI/web/lib/computer-usage-agent
git init
cat > package.json <<'EOF'
{
  "name": "computer-usage-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./protocol": "./src/protocol.ts"
  },
  "files": ["src"],
  "scripts": {
    "start": "tsx --env-file-if-exists=.env src/cli.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
EOF
cat > vitest.config.ts <<'EOF'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 15000 }
})
EOF
printf 'node_modules\n.env\n' > .gitignore
npm install mqtt systeminformation
npm install -D typescript tsx vitest aedes @types/node
```

- [ ] **Step 2: Write the failing test** — `test/protocol.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import {
  decodePayload, isValidHostId, parseCheckReply, parseCheckRequest, parseEvent,
  parseReading, parseStatus, parseTopic, topic
} from '../src/protocol'

const reading = { ts: '2026-01-01T00:00:00Z', cpuPercent: 12.5, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }] }

describe('host ids and topics', () => {
  it('accepts ordinary host ids', () => {
    for (const h of ['local', 'web-01', 'db_2.prod', 'A'.repeat(64)]) expect(isValidHostId(h)).toBe(true)
  })
  it('rejects ids that could become wildcards or extra topic levels', () => {
    for (const h of ['', 'a/b', '+', '#', 'a b', 'A'.repeat(65), '.', '..', 'x#', undefined, 5]) expect(isValidHostId(h)).toBe(false)
  })
  it('builds and parses topics', () => {
    expect(topic('web-01', 'heartbeat')).toBe('computer-usage/web-01/heartbeat')
    expect(parseTopic('computer-usage/web-01/event')).toEqual({ host: 'web-01', type: 'event' })
  })
  it('rejects unknown roots, types, depth and bad hosts', () => {
    for (const t of ['other/h/event', 'computer-usage/h/nope', 'computer-usage/h', 'computer-usage/h/event/x', 'computer-usage/+/event', 'computer-usage//event']) {
      expect(parseTopic(t)).toBeNull()
    }
  })
})

describe('decodePayload', () => {
  it('decodes JSON from strings and bytes, and returns undefined for garbage', () => {
    expect(decodePayload('{"a":1}')).toEqual({ a: 1 })
    expect(decodePayload(new TextEncoder().encode('[1]'))).toEqual([1])
    expect(decodePayload('not json')).toBeUndefined()
  })
})

describe('parseReading', () => {
  it('accepts a valid reading', () => {
    expect(parseReading(reading)).toEqual(reading)
  })
  it('rejects bad shapes and out-of-range values', () => {
    const bad = [
      null, 'x', [], { ...reading, ts: 'nope' }, { ...reading, ts: undefined },
      { ...reading, cpuPercent: 250 }, { ...reading, cpuPercent: -1 }, { ...reading, cpuPercent: NaN },
      { ...reading, memUsed: -5 }, { ...reading, memTotal: 'x' }, { ...reading, disks: 'x' },
      { ...reading, disks: [{ mount: '', used: 1, total: 2 }] },
      { ...reading, disks: [{ mount: '/', used: -1, total: 2 }] },
      { ...reading, disks: Array.from({ length: 65 }, (_, i) => ({ mount: `/m${i}`, used: 1, total: 2 })) }
    ]
    for (const b of bad) expect(parseReading(b)).toBeNull()
  })
  it('strips unknown fields', () => {
    expect(parseReading({ ...reading, extra: 1 })).toEqual(reading)
  })
})

describe('parseEvent', () => {
  const ev = { kind: 'memory', state: 'alert', value: 93.1, threshold: 90, ts: '2026-01-01T00:00:00Z' }
  it('accepts cpu/memory events and disk events with a mount', () => {
    expect(parseEvent(ev)).toEqual(ev)
    expect(parseEvent({ ...ev, kind: 'disk', mount: '/data' })).toEqual({ ...ev, kind: 'disk', mount: '/data' })
  })
  it('rejects unknown kinds/states, a disk event without a mount, and bad numbers', () => {
    for (const b of [{ ...ev, kind: 'gpu' }, { ...ev, state: 'meh' }, { ...ev, kind: 'disk' }, { ...ev, value: 'x' }, { ...ev, ts: 'x' }, null]) {
      expect(parseEvent(b)).toBeNull()
    }
  })
})

describe('check and status messages', () => {
  it('parses a check request and rejects missing/oversized ids', () => {
    expect(parseCheckRequest({ requestId: 'r1' })).toEqual({ requestId: 'r1' })
    expect(parseCheckRequest({})).toBeNull()
    expect(parseCheckRequest({ requestId: 'x'.repeat(65) })).toBeNull()
  })
  it('parses a check reply (reading plus request id)', () => {
    expect(parseCheckReply({ ...reading, requestId: 'r1' })).toEqual({ ...reading, requestId: 'r1' })
    expect(parseCheckReply(reading)).toBeNull()
  })
  it('parses status', () => {
    expect(parseStatus({ state: 'online' })).toEqual({ state: 'online' })
    expect(parseStatus({ state: 'maybe' })).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd /media/luis/data-luis/TYI/web/lib/computer-usage-agent && npx vitest run test/protocol.test.ts`
Expected: FAIL (cannot resolve `../src/protocol`).

- [ ] **Step 4: Implement** — `src/protocol.ts`

```ts
/** Wire protocol shared by the agent and the app. Must stay dependency-free: the Nuxt app imports it directly. */

export const TOPIC_ROOT = 'computer-usage'
export const MESSAGE_TYPES = ['heartbeat', 'event', 'check', 'reading', 'status'] as const
export type MessageType = typeof MESSAGE_TYPES[number]

export interface DiskReading { mount: string; used: number; total: number }
export interface Reading { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: DiskReading[] }
export type EventKind = 'cpu' | 'memory' | 'disk'
export interface UsageEvent { kind: EventKind; state: 'alert' | 'ok'; value: number; threshold: number; mount?: string; ts: string }
export interface CheckRequest { requestId: string }
export interface CheckReply extends Reading { requestId: string }
export interface StatusMessage { state: 'online' | 'offline' }

const HOST_ID = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_DISKS = 64
const MAX_MOUNT_LENGTH = 512
const MAX_REQUEST_ID_LENGTH = 64

/** Host ids end up inside MQTT topics, so anything that could be a wildcard or extra level is invalid. */
export const isValidHostId = (v: unknown): v is string => typeof v === 'string' && HOST_ID.test(v) && !/^\.+$/.test(v)

export const topic = (host: string, type: MessageType): string => `${TOPIC_ROOT}/${host}/${type}`

export function parseTopic(t: string): { host: string; type: MessageType } | null {
  const parts = t.split('/')
  if (parts.length !== 3 || parts[0] !== TOPIC_ROOT) return null
  const host = parts[1]!
  const type = parts[2]!
  if (!isValidHostId(host) || !(MESSAGE_TYPES as readonly string[]).includes(type)) return null
  return { host, type: type as MessageType }
}

export function decodePayload(payload: Uint8Array | string): unknown {
  try {
    return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload))
  } catch {
    return undefined
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonNeg = (v: unknown): v is number => isNum(v) && v >= 0
const isTs = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isMount = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_MOUNT_LENGTH

export function parseReading(v: unknown): Reading | null {
  if (!isObj(v)) return null
  const { ts, cpuPercent, memUsed, memTotal, disks } = v
  if (!isTs(ts) || !isNum(cpuPercent) || cpuPercent < 0 || cpuPercent > 100) return null
  if (!isNonNeg(memUsed) || !isNonNeg(memTotal) || !Array.isArray(disks) || disks.length > MAX_DISKS) return null
  const out: DiskReading[] = []
  for (const d of disks) {
    if (!isObj(d) || !isMount(d.mount) || !isNonNeg(d.used) || !isNonNeg(d.total)) return null
    out.push({ mount: d.mount, used: d.used, total: d.total })
  }
  return { ts, cpuPercent, memUsed, memTotal, disks: out }
}

export function parseEvent(v: unknown): UsageEvent | null {
  if (!isObj(v)) return null
  const { kind, state, value, threshold, ts, mount } = v
  if (kind !== 'cpu' && kind !== 'memory' && kind !== 'disk') return null
  if (state !== 'alert' && state !== 'ok') return null
  if (!isNum(value) || !isNum(threshold) || !isTs(ts)) return null
  if (kind === 'disk') {
    if (!isMount(mount)) return null
    return { kind, state, value, threshold, ts, mount }
  }
  return { kind, state, value, threshold, ts }
}

export function parseCheckRequest(v: unknown): CheckRequest | null {
  if (!isObj(v) || typeof v.requestId !== 'string' || v.requestId === '' || v.requestId.length > MAX_REQUEST_ID_LENGTH) return null
  return { requestId: v.requestId }
}

export function parseCheckReply(v: unknown): CheckReply | null {
  const req = parseCheckRequest(v)
  const reading = parseReading(v)
  return req && reading ? { ...reading, requestId: req.requestId } : null
}

export function parseStatus(v: unknown): StatusMessage | null {
  if (!isObj(v) || (v.state !== 'online' && v.state !== 'offline')) return null
  return { state: v.state }
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run test/protocol.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /media/luis/data-luis/TYI/web/lib/computer-usage-agent
printf '# computer-usage-agent\n\nAgent that reports a machine'"'"'s CPU, memory and disk usage to the computer-usage app over MQTT. Details are added in a later task.\n' > README.md
git add -A
git commit -m "feat: add computer-usage-agent package with wire protocol

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Threshold state machine

**Files:**
- Create: `lib/computer-usage-agent/src/thresholds.ts`
- Test: `lib/computer-usage-agent/test/thresholds.test.ts`

**Interfaces:**
- Consumes: `Reading`, `UsageEvent` from `./protocol`.
- Produces: `Thresholds { cpuPercent; cpuConsecutive; memoryPercent; diskPercent }`, `DEFAULT_THRESHOLDS`, `createThresholdEvaluator(t: Thresholds): (r: Reading) => UsageEvent[]`.

- [ ] **Step 1: Write the failing test** — `test/thresholds.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { Reading } from '../src/protocol'
import { DEFAULT_THRESHOLDS, createThresholdEvaluator } from '../src/thresholds'

let n = 0
const r = (o: Partial<Reading> = {}): Reading => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString(), cpuPercent: 10, memUsed: 50, memTotal: 100, disks: [{ mount: '/', used: 10, total: 100 }], ...o
})
const ev = () => createThresholdEvaluator(DEFAULT_THRESHOLDS)

describe('cpu', () => {
  it('alerts only after 3 consecutive checks at or above the threshold', () => {
    const e = ev()
    expect(e(r({ cpuPercent: 95 }))).toEqual([])
    expect(e(r({ cpuPercent: 95 }))).toEqual([])
    const out = e(r({ cpuPercent: 96 }))
    expect(out).toMatchObject([{ kind: 'cpu', state: 'alert', value: 96, threshold: 90 }])
  })
  it('a single spike never alerts and resets the streak', () => {
    const e = ev()
    for (const c of [95, 95, 20, 95, 95]) expect(e(r({ cpuPercent: c }))).toEqual([])
  })
  it('does not repeat while alerting, and emits one ok on recovery', () => {
    const e = ev()
    for (const c of [95, 95, 95]) e(r({ cpuPercent: c }))
    expect(e(r({ cpuPercent: 99 }))).toEqual([])
    expect(e(r({ cpuPercent: 40 }))).toMatchObject([{ kind: 'cpu', state: 'ok' }])
    expect(e(r({ cpuPercent: 40 }))).toEqual([])
  })
})

describe('memory', () => {
  it('alerts at exactly the threshold and recovers below it', () => {
    const e = ev()
    expect(e(r({ memUsed: 90 }))).toMatchObject([{ kind: 'memory', state: 'alert', value: 90 }])
    expect(e(r({ memUsed: 95 }))).toEqual([])
    expect(e(r({ memUsed: 89 }))).toMatchObject([{ kind: 'memory', state: 'ok' }])
  })
  it('ignores a reading with zero total memory', () => {
    expect(ev()(r({ memUsed: 0, memTotal: 0 }))).toEqual([])
  })
})

describe('disk', () => {
  const disks = (a: number, b: number) => [{ mount: '/', used: a, total: 100 }, { mount: '/data', used: b, total: 100 }]
  it('tracks each mount independently', () => {
    const e = ev()
    expect(e(r({ disks: disks(10, 95) }))).toMatchObject([{ kind: 'disk', state: 'alert', mount: '/data' }])
    expect(e(r({ disks: disks(91, 95) }))).toMatchObject([{ kind: 'disk', state: 'alert', mount: '/' }])
    expect(e(r({ disks: disks(10, 95) }))).toMatchObject([{ kind: 'disk', state: 'ok', mount: '/' }])
  })
  it('emits ok when a mount in alert disappears (e.g. USB removed), and is quiet for other vanished mounts', () => {
    const e = ev()
    e(r({ disks: disks(10, 95) }))
    expect(e(r({ disks: [{ mount: '/', used: 10, total: 100 }] }))).toMatchObject([{ kind: 'disk', state: 'ok', mount: '/data' }])
    expect(e(r({ disks: [] }))).toEqual([])
  })
  it('a mount that reappears starts from a fresh state', () => {
    const e = ev()
    e(r({ disks: disks(10, 95) }))
    e(r({ disks: [] }))
    expect(e(r({ disks: disks(10, 95) }))).toMatchObject([{ kind: 'disk', state: 'alert', mount: '/data' }])
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run test/thresholds.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/thresholds.ts`

```ts
import type { EventKind, Reading, UsageEvent } from './protocol'

export interface Thresholds { cpuPercent: number; cpuConsecutive: number; memoryPercent: number; diskPercent: number }
export const DEFAULT_THRESHOLDS: Thresholds = { cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 90, diskPercent: 90 }

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0)

/**
 * Turns successive readings into alert/ok events, emitting only on state changes.
 * CPU needs `cpuConsecutive` checks in a row at or above the threshold; memory and disk alert on the first.
 * A mount that vanishes while alerting emits an `ok` so the alert can clear.
 */
export function createThresholdEvaluator(t: Thresholds): (r: Reading) => UsageEvent[] {
  let cpuStreak = 0
  let cpuAlert = false
  let memAlert = false
  const diskAlert = new Map<string, boolean>()

  return (r) => {
    const out: UsageEvent[] = []
    const event = (kind: EventKind, state: 'alert' | 'ok', value: number, threshold: number, mount?: string): UsageEvent =>
      ({ kind, state, value: round1(value), threshold, ts: r.ts, ...(mount ? { mount } : {}) })

    cpuStreak = r.cpuPercent >= t.cpuPercent ? cpuStreak + 1 : 0
    if (!cpuAlert && cpuStreak >= t.cpuConsecutive) {
      cpuAlert = true
      out.push(event('cpu', 'alert', r.cpuPercent, t.cpuPercent))
    } else if (cpuAlert && r.cpuPercent < t.cpuPercent) {
      cpuAlert = false
      out.push(event('cpu', 'ok', r.cpuPercent, t.cpuPercent))
    }

    const mem = pct(r.memUsed, r.memTotal)
    if (r.memTotal > 0) {
      if (!memAlert && mem >= t.memoryPercent) {
        memAlert = true
        out.push(event('memory', 'alert', mem, t.memoryPercent))
      } else if (memAlert && mem < t.memoryPercent) {
        memAlert = false
        out.push(event('memory', 'ok', mem, t.memoryPercent))
      }
    }

    const seen = new Set<string>()
    for (const d of r.disks) {
      seen.add(d.mount)
      const p = pct(d.used, d.total)
      const was = diskAlert.get(d.mount) ?? false
      if (!was && p >= t.diskPercent) {
        diskAlert.set(d.mount, true)
        out.push(event('disk', 'alert', p, t.diskPercent, d.mount))
      } else if (was && p < t.diskPercent) {
        diskAlert.set(d.mount, false)
        out.push(event('disk', 'ok', p, t.diskPercent, d.mount))
      }
    }
    for (const [mount, was] of diskAlert) {
      if (seen.has(mount)) continue
      if (was) out.push(event('disk', 'ok', 0, t.diskPercent, mount))
      diskAlert.delete(mount)
    }
    return out
  }
}
```

- [ ] **Step 4: Run it to see it pass** — `npx vitest run test/thresholds.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add threshold state machine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Move the collector into the agent

**Files:**
- Create: `lib/computer-usage-agent/src/collector.ts`
- Test: `lib/computer-usage-agent/test/collector.test.ts` (copied from the app)

**Interfaces:**
- Consumes: `Reading` from `./protocol`.
- Produces: `collectReading(now?: Date): Promise<Reading>`, plus `normalizeDisks` and `toMetrics` (unchanged behavior).

- [ ] **Step 1: Copy the existing tests and point them at the new module**

```bash
cd /media/luis/data-luis/TYI/web
cp computer-usage/tests/collector.test.ts lib/computer-usage-agent/test/collector.test.ts
sed -i "s#'../server/utils/collector'#'../src/collector'#" lib/computer-usage-agent/test/collector.test.ts
cd lib/computer-usage-agent && npx vitest run test/collector.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 2: Implement** — `src/collector.ts`

```ts
import si from 'systeminformation'
import type { DiskReading, Reading } from './protocol'

export type Metrics = Omit<Reading, 'ts'>

interface RawFs { fs: string; mount: string; size: number; used: number }

const PSEUDO_MOUNT_PREFIXES = ['/sys/', '/proc/', '/dev/']
const VIRTUAL_FS_NAMES = new Set(['efivarfs', 'overlay', 'nsfs'])

export function normalizeDisks(raw: RawFs[]): DiskReading[] {
  const seen = new Set<string>()
  const out: DiskReading[] = []
  for (const d of raw) {
    if (!d.size || d.size <= 0) continue
    if (d.mount.startsWith('/snap/') || d.fs.startsWith('/dev/loop')) continue
    if (VIRTUAL_FS_NAMES.has(d.fs)) continue
    if (PSEUDO_MOUNT_PREFIXES.some(p => d.mount.startsWith(p))) continue
    if (d.mount.startsWith('/run/') && !d.mount.startsWith('/run/media/')) continue // keep removable disks
    if (seen.has(d.fs)) continue
    seen.add(d.fs)
    out.push({ mount: d.mount, used: d.used, total: d.size })
  }
  return out
}

export function toMetrics(load: { currentLoad: number }, mem: { total: number; available: number }, fs: RawFs[]): Metrics {
  const cpu = Number.isFinite(load.currentLoad) ? Math.min(100, Math.max(0, load.currentLoad)) : 0
  return {
    cpuPercent: Math.round(cpu * 10) / 10,
    memUsed: mem.total - mem.available,
    memTotal: mem.total,
    disks: normalizeDisks(fs)
  }
}

export async function collectReading(now: Date = new Date()): Promise<Reading> {
  const [load, mem, fs] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()])
  return { ts: now.toISOString(), ...toMetrics(load, mem, fs) }
}
```

- [ ] **Step 3: Run it to see it pass** — `npx vitest run test/collector.test.ts` → PASS (same cases as before).

- [ ] **Step 4: Smoke-test the real collector**

Run: `npx tsx -e "import('./src/collector.ts').then(m => m.collectReading()).then(r => console.log(JSON.stringify(r)))"`
Expected: one JSON line with a `ts`, `cpuPercent` between 0 and 100, memory bytes and at least one disk.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move metrics collector into the agent package

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bounded offline queue and agent logger

**Files:**
- Create: `lib/computer-usage-agent/src/queue.ts`, `lib/computer-usage-agent/src/log.ts`
- Test: `lib/computer-usage-agent/test/queue.test.ts`

**Interfaces:**
- Produces: `createBoundedQueue<T>(limit): { push(item): void; drain(): T[]; readonly size: number; readonly dropped: number }`; `logInfo`, `logError`, `logDebug` (message + optional context object).

- [ ] **Step 1: Write the failing test** — `test/queue.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { createBoundedQueue } from '../src/queue'

describe('createBoundedQueue', () => {
  it('drains items in order and empties itself', () => {
    const q = createBoundedQueue<number>(5)
    q.push(1); q.push(2)
    expect(q.drain()).toEqual([1, 2])
    expect(q.size).toBe(0)
  })
  it('keeps only the newest items beyond the limit and counts what it dropped', () => {
    const q = createBoundedQueue<number>(3)
    for (let i = 1; i <= 5; i++) q.push(i)
    expect(q.drain()).toEqual([3, 4, 5])
    expect(q.dropped).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run test/queue.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/queue.ts`:
```ts
/** FIFO buffer that keeps only the newest `limit` items, so a long outage cannot grow memory without bound. */
export function createBoundedQueue<T>(limit: number) {
  const items: T[] = []
  let dropped = 0
  return {
    push(item: T): void {
      items.push(item)
      while (items.length > limit) { items.shift(); dropped++ }
    },
    drain(): T[] { return items.splice(0, items.length) },
    get size() { return items.length },
    get dropped() { return dropped }
  }
}
```

`src/log.ts`:
```ts
const debugOn = () => ['true', '1'].includes(process.env.NUXT_ADD_DEBUG_LOGS ?? '')
const fmt = (level: string, msg: string, ctx?: Record<string, unknown>) =>
  `[computer-usage-agent] ${new Date().toISOString()} ${level} ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`

export const logInfo = (msg: string, ctx?: Record<string, unknown>) => console.log(fmt('INFO', msg, ctx))
export const logError = (msg: string, ctx?: Record<string, unknown>) => console.error(fmt('ERROR', msg, ctx))
export const logDebug = (msg: string, ctx?: Record<string, unknown>) => { if (debugOn()) console.log(fmt('DEBUG', msg, ctx)) }
```

- [ ] **Step 4: Run it to see it pass** — `npx vitest run test/queue.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add bounded offline queue and logger

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Agent runtime (MQTT) with an in-process broker test

**Files:**
- Create: `lib/computer-usage-agent/src/agent.ts`
- Create: `lib/computer-usage-agent/test/helpers/broker.ts`
- Test: `lib/computer-usage-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: `collectReading` (Task 3), `createThresholdEvaluator`/`Thresholds` (Task 2), `createBoundedQueue` (Task 4), `topic`, `parseCheckRequest`, `decodePayload`, `Reading` (Task 1), loggers (Task 4).
- Produces: `AgentConfig { hostId; mqttUrl; username?; password?; heartbeatIntervalMs; checkIntervalMs; thresholds: Thresholds; queueLimit; reconnectPeriodMs? }`, `Agent { stop(): Promise<void> }`, `startAgent(cfg, collect?: () => Promise<Reading>): Agent`.

- [ ] **Step 1: Test helper** — `test/helpers/broker.ts` (aedes 1.x API, verified: `Aedes.createBroker()` + `net.createServer(broker.handle)`)

```ts
import { Aedes } from 'aedes'
import net from 'node:net'

export async function startBroker(port = 0) {
  const broker = await Aedes.createBroker()
  const server = net.createServer(broker.handle)
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r))
  const boundPort = (server.address() as net.AddressInfo).port
  return {
    port: boundPort,
    url: `mqtt://127.0.0.1:${boundPort}`,
    async stop() {
      await new Promise<void>(r => broker.close(() => r()))
      await new Promise<void>(r => server.close(() => r()))
    }
  }
}

export async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as net.AddressInfo).port
  await new Promise<void>(r => s.close(() => r()))
  return p
}
```

- [ ] **Step 2: Write the failing test** — `test/agent.test.ts`

```ts
import mqtt, { type MqttClient } from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgent, type Agent, type AgentConfig } from '../src/agent'
import type { Reading } from '../src/protocol'
import { DEFAULT_THRESHOLDS } from '../src/thresholds'
import { freePort, startBroker } from './helpers/broker'

const reading = (o: Partial<Reading> = {}): Reading => ({
  ts: new Date().toISOString(), cpuPercent: 10, memUsed: 50, memTotal: 100, disks: [{ mount: '/', used: 10, total: 100 }], ...o
})
const config = (url: string, o: Partial<AgentConfig> = {}): AgentConfig => ({
  hostId: 'h1', mqttUrl: url, heartbeatIntervalMs: 60_000, checkIntervalMs: 60_000,
  thresholds: DEFAULT_THRESHOLDS, queueLimit: 100, reconnectPeriodMs: 100, ...o
})

type Msg = { topic: string; payload: any }
async function observe(url: string): Promise<{ client: MqttClient; msgs: Msg[] }> {
  const client = mqtt.connect(url)
  const msgs: Msg[] = []
  client.on('message', (topic, p) => msgs.push({ topic, payload: JSON.parse(p.toString()) }))
  await new Promise<void>(r => client.on('connect', () => r()))
  await client.subscribeAsync('computer-usage/h1/#', { qos: 1 })
  return { client, msgs }
}
async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v !== undefined) return v; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('timed out waiting for condition')
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

describe('agent', () => {
  it('publishes online status and a heartbeat reading right after connecting', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent: Agent = startAgent(config(broker.url), async () => reading()); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status' && m.payload.state === 'online'))
    const hb = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/heartbeat'))
    expect(hb.payload).toMatchObject({ cpuPercent: 10, memTotal: 100 })
  })

  it('publishes an alert event when a threshold is crossed', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url), async () => reading({ memUsed: 95 })); cleanup.push(() => agent.stop())
    const e = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/event'))
    expect(e.payload).toMatchObject({ kind: 'memory', state: 'alert', threshold: 90 })
  })

  it('answers a check request with a reading carrying the same request id', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url), async () => reading()); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status'))
    await new Promise(r => setTimeout(r, 200)) // let the agent's check-topic subscription settle
    await client.publishAsync('computer-usage/h1/check', JSON.stringify({ requestId: 'r-42' }), { qos: 1 })
    const reply = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/reading'))
    expect(reply.payload.requestId).toBe('r-42')
  })

  it('ignores a malformed check request and keeps running', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url), async () => reading()); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status'))
    await new Promise(r => setTimeout(r, 200))
    await client.publishAsync('computer-usage/h1/check', 'not json', { qos: 1 })
    await client.publishAsync('computer-usage/h1/check', JSON.stringify({ requestId: 'ok-1' }), { qos: 1 })
    const reply = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/reading'))
    expect(reply.payload.requestId).toBe('ok-1')
  })

  it('queues heartbeats while the broker is unreachable and delivers them after it comes up', async () => {
    const port = await freePort()
    const agent = startAgent(config(`mqtt://127.0.0.1:${port}`), async () => reading({ cpuPercent: 33 })); cleanup.push(() => agent.stop())
    await new Promise(r => setTimeout(r, 400)) // first heartbeat is collected while offline
    const broker = await startBroker(port); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const hb = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/heartbeat' && m.payload.cpuPercent === 33))
    expect(hb).toBeDefined()
  })
})
```

- [ ] **Step 3: Run it to see it fail** — `npx vitest run test/agent.test.ts` → FAIL (module `../src/agent` not found).

- [ ] **Step 4: Implement** — `src/agent.ts`

```ts
import mqtt from 'mqtt'
import { collectReading } from './collector'
import { logDebug, logError, logInfo } from './log'
import { decodePayload, parseCheckRequest, topic, type MessageType, type Reading } from './protocol'
import { createBoundedQueue } from './queue'
import { createThresholdEvaluator, type Thresholds } from './thresholds'

export interface AgentConfig {
  hostId: string
  mqttUrl: string
  username?: string
  password?: string
  heartbeatIntervalMs: number
  checkIntervalMs: number
  thresholds: Thresholds
  queueLimit: number
  reconnectPeriodMs?: number
}
export interface Agent { stop(): Promise<void> }

interface Outgoing { topic: string; payload: string }
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function startAgent(cfg: AgentConfig, collect: () => Promise<Reading> = () => collectReading()): Agent {
  const evaluate = createThresholdEvaluator(cfg.thresholds)
  const queue = createBoundedQueue<Outgoing>(cfg.queueLimit)
  const statusTopic = topic(cfg.hostId, 'status')
  const checkTopic = topic(cfg.hostId, 'check')
  const offline = JSON.stringify({ state: 'offline' })

  const client = mqtt.connect(cfg.mqttUrl, {
    clientId: `computer-usage-agent-${cfg.hostId}`,
    clean: false, // persistent session: the broker keeps QoS 1 messages meant for us while we are away
    reconnectPeriod: cfg.reconnectPeriodMs ?? 2000,
    username: cfg.username,
    password: cfg.password,
    will: { topic: statusTopic, payload: Buffer.from(offline), qos: 1, retain: true }
  })

  const publish = (type: MessageType, payload: unknown, queueIfOffline: boolean) => {
    const msg = { topic: topic(cfg.hostId, type), payload: JSON.stringify(payload) }
    if (client.connected) {
      client.publish(msg.topic, msg.payload, { qos: 1 }, (err) => { if (err) logError('publish failed', { topic: msg.topic, error: errMsg(err) }) })
    } else if (queueIfOffline) {
      queue.push(msg)
      logDebug('queued while offline', { topic: msg.topic, queued: queue.size, dropped: queue.dropped })
    }
  }

  /** Runs `fn` unless the previous run is still going; failures are logged and swallowed so the timer keeps firing. */
  const guarded = (name: string, fn: () => Promise<void>) => {
    let running = false
    return async () => {
      if (running) { logDebug(`${name} skipped: previous still running`); return }
      running = true
      try { await fn() } catch (err) { logError(`${name} failed`, { hostId: cfg.hostId, error: errMsg(err) }) } finally { running = false }
    }
  }

  const heartbeat = guarded('heartbeat', async () => {
    publish('heartbeat', await collect(), true)
    logDebug('heartbeat collected', { hostId: cfg.hostId })
  })
  const thresholdCheck = guarded('threshold check', async () => {
    for (const e of evaluate(await collect())) {
      logInfo('threshold event', { hostId: cfg.hostId, ...e })
      publish('event', e, true)
    }
  })
  const answerCheck = async (requestId: string) => {
    try {
      publish('reading', { ...(await collect()), requestId }, false)
      logDebug('check answered', { requestId })
    } catch (err) {
      logError('check reply failed', { hostId: cfg.hostId, requestId, error: errMsg(err) })
    }
  }

  client.on('connect', () => {
    logInfo('connected to broker', { hostId: cfg.hostId, queued: queue.size })
    client.publish(statusTopic, JSON.stringify({ state: 'online' }), { qos: 1, retain: true })
    client.subscribe(checkTopic, { qos: 1 }, (err) => { if (err) logError('subscribe failed', { topic: checkTopic, error: errMsg(err) }) })
    for (const m of queue.drain()) client.publish(m.topic, m.payload, { qos: 1 })
  })
  client.on('error', err => logError('mqtt error', { hostId: cfg.hostId, error: errMsg(err) }))
  client.on('close', () => logDebug('mqtt connection closed', { hostId: cfg.hostId }))
  client.on('message', (t, payload) => {
    if (t !== checkTopic) return
    const req = parseCheckRequest(decodePayload(payload))
    if (!req) { logError('invalid check request', { hostId: cfg.hostId, payload: payload.toString().slice(0, 200) }); return }
    void answerCheck(req.requestId)
  })

  void heartbeat()
  void thresholdCheck()
  const heartbeatTimer = setInterval(() => void heartbeat(), cfg.heartbeatIntervalMs)
  const checkTimer = setInterval(() => void thresholdCheck(), cfg.checkIntervalMs)
  logInfo('agent started', { hostId: cfg.hostId, heartbeatIntervalMs: cfg.heartbeatIntervalMs, checkIntervalMs: cfg.checkIntervalMs })

  return {
    async stop() {
      clearInterval(heartbeatTimer)
      clearInterval(checkTimer)
      if (client.connected) await client.publishAsync(statusTopic, offline, { qos: 1, retain: true })
      await client.endAsync()
      logInfo('agent stopped', { hostId: cfg.hostId })
    }
  }
}
```

- [ ] **Step 5: Run it to see it pass** — `npx vitest run test/agent.test.ts` → all 5 PASS. If a test times out, run with `NUXT_ADD_DEBUG_LOGS=true` to see the agent's trace.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add MQTT agent runtime

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agent config, CLI and README

**Files:**
- Create: `lib/computer-usage-agent/src/config.ts`, `src/cli.ts`, `src/index.ts`, `.env.example`
- Modify: `lib/computer-usage-agent/README.md`
- Test: `lib/computer-usage-agent/test/config.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `startAgent` (Task 5), `isValidHostId` (Task 1), `DEFAULT_THRESHOLDS` (Task 2).
- Produces: `readAgentConfig(env: Record<string, string | undefined>): AgentConfig` (throws `Error` naming the offending variable).

- [ ] **Step 1: Write the failing test** — `test/config.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { readAgentConfig } from '../src/config'

describe('readAgentConfig', () => {
  it('applies defaults and uses the host id as the MQTT username', () => {
    const c = readAgentConfig({ HOST_ID: 'web-01' })
    expect(c).toMatchObject({
      hostId: 'web-01', mqttUrl: 'mqtt://localhost:1883', username: 'web-01',
      heartbeatIntervalMs: 300000, checkIntervalMs: 20000, queueLimit: 1000,
      thresholds: { cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 90, diskPercent: 90 }
    })
  })
  it('reads overrides', () => {
    const c = readAgentConfig({
      HOST_ID: 'h', MQTT_URL: 'mqtt://broker:1883', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p', HEARTBEAT_INTERVAL_MS: '1000',
      CHECK_INTERVAL_MS: '500', CPU_THRESHOLD_PERCENT: '80', CPU_CONSECUTIVE_CHECKS: '2', MEMORY_THRESHOLD_PERCENT: '85', DISK_THRESHOLD_PERCENT: '95', QUEUE_LIMIT: '10'
    })
    expect(c).toMatchObject({ mqttUrl: 'mqtt://broker:1883', username: 'u', password: 'p', heartbeatIntervalMs: 1000, checkIntervalMs: 500, queueLimit: 10, thresholds: { cpuPercent: 80, cpuConsecutive: 2, memoryPercent: 85, diskPercent: 95 } })
  })
  it('requires a valid HOST_ID', () => {
    expect(() => readAgentConfig({})).toThrow(/HOST_ID/)
    expect(() => readAgentConfig({ HOST_ID: 'a/b' })).toThrow(/HOST_ID/)
  })
  it('names the variable when a number is invalid', () => {
    expect(() => readAgentConfig({ HOST_ID: 'h', HEARTBEAT_INTERVAL_MS: 'soon' })).toThrow(/HEARTBEAT_INTERVAL_MS/)
    expect(() => readAgentConfig({ HOST_ID: 'h', CPU_THRESHOLD_PERCENT: '150' })).toThrow(/CPU_THRESHOLD_PERCENT/)
    expect(() => readAgentConfig({ HOST_ID: 'h', CHECK_INTERVAL_MS: '0' })).toThrow(/CHECK_INTERVAL_MS/)
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run test/config.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/config.ts`:
```ts
import type { AgentConfig } from './agent'
import { isValidHostId } from './protocol'
import { DEFAULT_THRESHOLDS } from './thresholds'

type Env = Record<string, string | undefined>

function num(env: Env, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`)
  return n
}

export function readAgentConfig(env: Env): AgentConfig {
  const hostId = env.HOST_ID
  if (!isValidHostId(hostId)) throw new Error('HOST_ID is required: 1-64 characters of letters, digits, "_", "." or "-"')
  return {
    hostId,
    mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
    username: env.MQTT_USERNAME || hostId,
    password: env.MQTT_PASSWORD || undefined,
    heartbeatIntervalMs: num(env, 'HEARTBEAT_INTERVAL_MS', 300_000, 1),
    checkIntervalMs: num(env, 'CHECK_INTERVAL_MS', 20_000, 1),
    queueLimit: num(env, 'QUEUE_LIMIT', 1000, 1),
    thresholds: {
      cpuPercent: num(env, 'CPU_THRESHOLD_PERCENT', DEFAULT_THRESHOLDS.cpuPercent, 1, 100),
      cpuConsecutive: num(env, 'CPU_CONSECUTIVE_CHECKS', DEFAULT_THRESHOLDS.cpuConsecutive, 1),
      memoryPercent: num(env, 'MEMORY_THRESHOLD_PERCENT', DEFAULT_THRESHOLDS.memoryPercent, 1, 100),
      diskPercent: num(env, 'DISK_THRESHOLD_PERCENT', DEFAULT_THRESHOLDS.diskPercent, 1, 100)
    }
  }
}
```

`src/cli.ts`:
```ts
import { startAgent } from './agent'
import { readAgentConfig } from './config'
import { logError } from './log'

try {
  const agent = startAgent(readAgentConfig(process.env))
  const shutdown = () => { void agent.stop().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  logError('agent failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}
```

`src/index.ts`:
```ts
export * from './protocol'
export * from './thresholds'
export * from './collector'
export * from './agent'
export * from './config'
```

`.env.example`:
```
HOST_ID=local
MQTT_URL=mqtt://localhost:1883
MQTT_USERNAME=local
MQTT_PASSWORD=changeme-local
HEARTBEAT_INTERVAL_MS=300000
CHECK_INTERVAL_MS=20000
CPU_THRESHOLD_PERCENT=90
CPU_CONSECUTIVE_CHECKS=3
MEMORY_THRESHOLD_PERCENT=90
DISK_THRESHOLD_PERCENT=90
QUEUE_LIMIT=1000
NUXT_ADD_DEBUG_LOGS=false
```

- [ ] **Step 4: Replace `README.md`**

```markdown
# computer-usage-agent

Reports this machine's CPU, memory and disk usage to the computer-usage app over MQTT. Run one agent on every machine you want to monitor, including the one that runs the app.

## Run

    cp .env.example .env     # set HOST_ID and the broker credentials
    npm install
    npm start

The agent publishes a heartbeat reading every `HEARTBEAT_INTERVAL_MS` (default 5 min) and an event when CPU, memory or a disk crosses its threshold (and when it recovers). It also answers "Check now" requests from the dashboard.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HOST_ID` | required | Name shown in the dashboard. Letters, digits, `_`, `.`, `-` (max 64). |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker URL. |
| `MQTT_USERNAME` | `HOST_ID` | Must equal `HOST_ID`: the broker ACL only lets a user publish under its own host topic. |
| `MQTT_PASSWORD` | none | Password created with `docker/mosquitto/add-user.sh` in the app repo. |
| `HEARTBEAT_INTERVAL_MS` | `300000` | Milliseconds between heartbeat readings. |
| `CHECK_INTERVAL_MS` | `20000` | Milliseconds between threshold checks. |
| `CPU_THRESHOLD_PERCENT` / `CPU_CONSECUTIVE_CHECKS` | `90` / `3` | CPU alerts after this many consecutive checks at or above the threshold. |
| `MEMORY_THRESHOLD_PERCENT` | `90` | Memory alert threshold (used %). |
| `DISK_THRESHOLD_PERCENT` | `90` | Disk alert threshold (used %), per mount. |
| `QUEUE_LIMIT` | `1000` | Messages kept while the broker is unreachable (newest kept). |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables tracing logs. |

## Consumers

The computer-usage app imports `computer-usage-agent/protocol` (topics and payload validation). The protocol file has no dependencies on purpose.

## Test

    npm test      # uses an in-process broker, no Docker needed
```

- [ ] **Step 5: Run everything** — `npx vitest run && npx tsc --noEmit` → all tests PASS, no type errors. Fix any type errors before continuing (for example `payload.toString()` on the mqtt `Buffer`, or option types).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add agent config, CLI and README

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Stage 2 — App: schema, ingest, MQTT, API

### Task 7: Link the package, change the schema, extend the repository

**Files (all in `web/computer-usage/`):**
- Modify: `package.json` (via npm), `nuxt.config.ts`, `server/db/schema.ts`, `server/utils/repository.ts`, `tests/repository.test.ts`, `tests/db.test.ts`
- Create: `drizzle/0002_*.sql` (generated; the retention work did not add a migration, so this is the second migration file: check the name `npm run db:generate` prints)

**Interfaces:**
- Consumes: `Reading`, `UsageEvent`, `DiskReading` from `computer-usage-agent/protocol`.
- Produces — `createRepository(db)` returns:
  - `saveSample(hostId: string, r: Reading): Promise<number | null>` (null = duplicate ignored)
  - `saveEvent(hostId: string, e: UsageEvent): Promise<boolean>` (false = duplicate)
  - `touchHost(hostId: string, opts?: { online?: boolean }, now?: Date): Promise<void>`
  - `listHosts(): Promise<HostRow[]>` with `HostRow { hostId: string; online: boolean; lastSeen: string }`
  - `getHistory(hostId: string, range: HistoryRange, now?: Date): Promise<HistoryPoint[]>`
  - `getLatest(hostId: string): Promise<HistoryPoint | null>`
  - `getRecentEvents(hostId: string, limit?: number): Promise<UsageEvent[]>` (newest first)
  - `pruneOlderThan(cutoff: Date): Promise<number>` (samples, unchanged) and `pruneEventsOlderThan(cutoff: Date): Promise<number>`
  - `HistoryPoint = Reading` (same shape).

- [ ] **Step 1: Link the package and add `mqtt`**

```bash
cd /media/luis/data-luis/TYI/web/computer-usage
npm install ../lib/computer-usage-agent mqtt
```
Confirm `package.json` now lists `"computer-usage-agent": "file:../lib/computer-usage-agent"` and `mqtt`.

- [ ] **Step 2: Let Nitro bundle the linked TypeScript package** — modify `nuxt.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  // The shared package ships TypeScript source, so it must be bundled instead of left as an external import.
  nitro: { externals: { inline: ['computer-usage-agent'] } },
  build: { transpile: ['computer-usage-agent'] }
})
```

- [ ] **Step 3: Rewrite `server/db/schema.ts`**

```ts
import { bigint, boolean, index, integer, pgTable, real, serial, text, timestamp, unique } from 'drizzle-orm/pg-core'

export const samples = pgTable('samples', {
  id: serial('id').primaryKey(),
  // Existing single-machine rows are backfilled with 'local' by the column default.
  hostId: text('host_id').notNull().default('local'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  cpuPercent: real('cpu_percent').notNull(),
  memUsed: bigint('mem_used', { mode: 'number' }).notNull(),
  memTotal: bigint('mem_total', { mode: 'number' }).notNull()
}, t => [
  index('samples_host_ts_idx').on(t.hostId, t.ts),
  unique('samples_host_ts_unique').on(t.hostId, t.ts)
])

export const diskSamples = pgTable('disk_samples', {
  id: serial('id').primaryKey(),
  sampleId: integer('sample_id').notNull().references(() => samples.id, { onDelete: 'cascade' }),
  mount: text('mount').notNull(),
  used: bigint('used', { mode: 'number' }).notNull(),
  total: bigint('total', { mode: 'number' }).notNull()
}, t => [index('disk_samples_sample_idx').on(t.sampleId)])

export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  hostId: text('host_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  value: real('value').notNull(),
  threshold: real('threshold').notNull(),
  mount: text('mount').notNull().default('') // '' for cpu/memory events
}, t => [
  index('events_host_ts_idx').on(t.hostId, t.ts),
  unique('events_dedupe').on(t.hostId, t.ts, t.kind, t.state, t.mount)
])

export const hosts = pgTable('hosts', {
  hostId: text('host_id').primaryKey(),
  online: boolean('online').notNull().default(false),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow()
})
```

- [ ] **Step 4: Generate the migration and inspect it**

Run: `npm run db:generate` (if drizzle-kit asks whether something was renamed, answer "create"/"drop", never "rename").
Open the new `drizzle/000N_*.sql` and confirm it: adds `host_id` with `DEFAULT 'local' NOT NULL`, drops `samples_ts_idx`, creates `samples_host_ts_idx`, adds the `samples_host_ts_unique` constraint, and creates `events` and `hosts`. If the `DEFAULT 'local'` is missing, existing rows would fail the NOT NULL: fix the schema and regenerate.

- [ ] **Step 5: Rewrite `tests/repository.test.ts`** (requires Postgres: `docker compose up -d`)

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Reading } from 'computer-usage-agent/protocol'
import { createDb } from '../server/db'
import { runMigrations } from '../server/db/migrate'
import { createRepository } from '../server/utils/repository'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage-test'
const { db, pool } = createDb(url)
const repo = createRepository(db)
const r = (cpu: number, ts: string): Reading => ({
  ts, cpuPercent: cpu, memUsed: 5, memTotal: 10,
  disks: [{ mount: '/', used: 1, total: 2 }, { mount: '/data', used: 3, total: 4 }]
})

beforeAll(() => runMigrations(db))
beforeEach(() => db.execute(sql`truncate samples, events, hosts restart identity cascade`))
afterAll(() => pool.end())

describe('samples', () => {
  it('returns [] when there is no data', async () => {
    expect(await repo.getHistory('h1', '1h')).toEqual([])
    expect(await repo.getLatest('h1')).toBeNull()
  })
  it('saves a sample with its disks and reads it back', async () => {
    await repo.saveSample('h1', r(42, '2026-01-01T11:59:00Z'))
    const h = await repo.getHistory('h1', '1h', new Date('2026-01-01T12:00:00Z'))
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ cpuPercent: 42, memUsed: 5, memTotal: 10 })
    expect(h[0]!.disks).toEqual([{ mount: '/', used: 1, total: 2 }, { mount: '/data', used: 3, total: 4 }])
  })
  it('keeps hosts separate', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T11:59:00Z'))
    await repo.saveSample('h2', r(2, '2026-01-01T11:59:00Z'))
    const now = new Date('2026-01-01T12:00:00Z')
    expect((await repo.getHistory('h1', '1h', now)).map(p => p.cpuPercent)).toEqual([1])
    expect((await repo.getHistory('h2', '1h', now)).map(p => p.cpuPercent)).toEqual([2])
  })
  it('filters by range and orders ascending by ts', async () => {
    const now = new Date('2026-01-01T12:00:00Z')
    await repo.saveSample('h1', r(3, '2026-01-01T11:30:00Z'))
    await repo.saveSample('h1', r(1, '2026-01-01T10:00:00Z')) // outside 1h
    await repo.saveSample('h1', r(2, '2026-01-01T11:10:00Z'))
    expect((await repo.getHistory('h1', '1h', now)).map(p => p.cpuPercent)).toEqual([2, 3])
  })
  it('ignores a duplicate delivery of the same sample (QoS 1 redelivery)', async () => {
    expect(await repo.saveSample('h1', r(1, '2026-01-01T11:59:00Z'))).toEqual(expect.any(Number))
    expect(await repo.saveSample('h1', r(1, '2026-01-01T11:59:00Z'))).toBeNull()
    expect(await repo.getHistory('h1', '1h', new Date('2026-01-01T12:00:00Z'))).toHaveLength(1)
    const left = await db.execute(sql`select count(*)::int as n from disk_samples`)
    expect(left.rows[0]).toEqual({ n: 2 })
  })
  it('saves a sample with no disks', async () => {
    await repo.saveSample('h1', { ...r(1, '2026-01-01T11:59:00Z'), disks: [] })
    expect((await repo.getHistory('h1', '1h', new Date('2026-01-01T12:00:00Z')))[0]!.disks).toEqual([])
  })
  it('returns the latest sample for a host', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T10:00:00Z'))
    await repo.saveSample('h1', r(2, '2026-01-01T11:00:00Z'))
    expect((await repo.getLatest('h1'))?.cpuPercent).toBe(2)
  })
  it('prunes samples older than the cutoff and cascades to their disks', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T00:00:00Z'))
    await repo.saveSample('h1', r(2, '2026-01-20T00:00:00Z'))
    expect(await repo.pruneOlderThan(new Date('2026-01-10T00:00:00Z'))).toBe(1)
    expect((await repo.getHistory('h1', '7d', new Date('2026-01-21T00:00:00Z'))).map(p => p.cpuPercent)).toEqual([2])
    expect((await db.execute(sql`select count(*)::int as n from disk_samples`)).rows[0]).toEqual({ n: 2 })
  })
})

describe('events', () => {
  const e = { kind: 'memory' as const, state: 'alert' as const, value: 93, threshold: 90, ts: '2026-01-01T11:00:00Z' }
  it('stores events and lists them newest first, with disk mounts', async () => {
    await repo.saveEvent('h1', e)
    await repo.saveEvent('h1', { kind: 'disk', state: 'alert', value: 95, threshold: 90, mount: '/data', ts: '2026-01-01T12:00:00Z' })
    const list = await repo.getRecentEvents('h1', 10)
    expect(list.map(x => x.kind)).toEqual(['disk', 'memory'])
    expect(list[0]!.mount).toBe('/data')
    expect(list[1]!.mount).toBeUndefined()
  })
  it('ignores a duplicate delivery of the same event', async () => {
    expect(await repo.saveEvent('h1', e)).toBe(true)
    expect(await repo.saveEvent('h1', e)).toBe(false)
    expect(await repo.getRecentEvents('h1', 10)).toHaveLength(1)
  })
  it('honours the limit and prunes old events', async () => {
    await repo.saveEvent('h1', e)
    await repo.saveEvent('h1', { ...e, state: 'ok', ts: '2026-01-02T00:00:00Z' })
    expect(await repo.getRecentEvents('h1', 1)).toHaveLength(1)
    expect(await repo.pruneEventsOlderThan(new Date('2026-01-01T12:00:00Z'))).toBe(1)
    expect(await repo.getRecentEvents('h1', 10)).toHaveLength(1)
  })
})

describe('hosts', () => {
  it('registers a host on first contact and tracks online state and last seen', async () => {
    await repo.touchHost('h1', { online: true }, new Date('2026-01-01T00:00:00Z'))
    await repo.touchHost('h1', { online: false }, new Date('2026-01-01T00:05:00Z'))
    await repo.touchHost('h0', { online: true }, new Date('2026-01-01T00:01:00Z'))
    expect(await repo.listHosts()).toEqual([
      { hostId: 'h0', online: true, lastSeen: '2026-01-01T00:01:00.000Z' },
      { hostId: 'h1', online: false, lastSeen: '2026-01-01T00:05:00.000Z' }
    ])
  })
  it('keeps the online flag when touched without one', async () => {
    await repo.touchHost('h1', { online: true })
    await repo.touchHost('h1')
    expect((await repo.listHosts())[0]!.online).toBe(true)
  })
})
```

- [ ] **Step 6: Update `tests/db.test.ts`** — extend the table list in the migration test:

Replace the query/expectation with:
```ts
    const r = await db.execute(sql`select table_name from information_schema.tables where table_schema='public' and table_name in ('samples','disk_samples','events','hosts')`)
    expect(r.rows.map((x: any) => x.table_name).sort()).toEqual(['disk_samples', 'events', 'hosts', 'samples'])
```
and rename the test to `creates samples, disk_samples, events and hosts tables and is idempotent`.

- [ ] **Step 7: Run to see it fail** — `npx vitest run tests/repository.test.ts tests/db.test.ts` → FAIL (repository has no `host` support yet). Without Docker these fail with `ECONNREFUSED`; if so, say so and continue, but do not claim they pass.

- [ ] **Step 8: Rewrite `server/utils/repository.ts`**

```ts
import { and, asc, desc, eq, gte, lt, type SQL } from 'drizzle-orm'
import type { DiskReading, Reading, UsageEvent } from 'computer-usage-agent/protocol'
import type { Db } from '../db'
import { diskSamples, events, hosts, samples } from '../db/schema'
import { logDebug } from './log'
import { RANGE_MS, type HistoryRange } from './range'

export type HistoryPoint = Reading
export interface HostRow { hostId: string; online: boolean; lastSeen: string }

export function createRepository(db: Db) {
  const selectPoints = (where: SQL | undefined) => db.select({
    id: samples.id, ts: samples.ts, cpuPercent: samples.cpuPercent, memUsed: samples.memUsed, memTotal: samples.memTotal,
    mount: diskSamples.mount, used: diskSamples.used, total: diskSamples.total
  })
    .from(samples)
    .leftJoin(diskSamples, eq(diskSamples.sampleId, samples.id))
    .where(where)
    .orderBy(asc(samples.ts), asc(samples.id), asc(diskSamples.id))

  async function pointsWhere(where: SQL | undefined): Promise<HistoryPoint[]> {
    const rows = await selectPoints(where)
    const byId = new Map<number, HistoryPoint>()
    for (const r of rows) {
      let p = byId.get(r.id)
      if (!p) {
        p = { ts: r.ts.toISOString(), cpuPercent: r.cpuPercent, memUsed: r.memUsed, memTotal: r.memTotal, disks: [] as DiskReading[] }
        byId.set(r.id, p)
      }
      if (r.mount !== null) p.disks.push({ mount: r.mount, used: r.used!, total: r.total! })
    }
    return [...byId.values()]
  }

  return {
    /** Stores a reading and its disks. Returns the new id, or null when this (host, ts) was already stored. */
    async saveSample(hostId: string, r: Reading): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(samples)
          .values({ hostId, ts: new Date(r.ts), cpuPercent: r.cpuPercent, memUsed: r.memUsed, memTotal: r.memTotal })
          .onConflictDoNothing({ target: [samples.hostId, samples.ts] })
          .returning({ id: samples.id })
        if (!row) { logDebug('duplicate sample ignored', { hostId, ts: r.ts }); return null }
        if (r.disks.length) {
          await tx.insert(diskSamples).values(r.disks.map(d => ({ sampleId: row.id, mount: d.mount, used: d.used, total: d.total })))
        }
        logDebug('sample saved', { id: row.id, hostId, disks: r.disks.length })
        return row.id
      })
    },

    /** Stores an alert/ok event. Returns false when the same event was already stored. */
    async saveEvent(hostId: string, e: UsageEvent): Promise<boolean> {
      const rows = await db.insert(events)
        .values({ hostId, ts: new Date(e.ts), kind: e.kind, state: e.state, value: e.value, threshold: e.threshold, mount: e.mount ?? '' })
        .onConflictDoNothing()
        .returning({ id: events.id })
      logDebug(rows.length ? 'event saved' : 'duplicate event ignored', { hostId, kind: e.kind, state: e.state })
      return rows.length > 0
    },

    async touchHost(hostId: string, opts: { online?: boolean } = {}, now: Date = new Date()): Promise<void> {
      await db.insert(hosts)
        .values({ hostId, online: opts.online ?? false, lastSeen: now })
        .onConflictDoUpdate({
          target: hosts.hostId,
          set: { lastSeen: now, ...(opts.online === undefined ? {} : { online: opts.online }) }
        })
    },

    async listHosts(): Promise<HostRow[]> {
      const rows = await db.select().from(hosts).orderBy(asc(hosts.hostId))
      return rows.map(h => ({ hostId: h.hostId, online: h.online, lastSeen: h.lastSeen.toISOString() }))
    },

    async getHistory(hostId: string, range: HistoryRange, now: Date = new Date()): Promise<HistoryPoint[]> {
      const since = new Date(now.getTime() - RANGE_MS[range])
      return pointsWhere(and(eq(samples.hostId, hostId), gte(samples.ts, since)))
    },

    async getLatest(hostId: string): Promise<HistoryPoint | null> {
      const [latest] = await db.select({ id: samples.id }).from(samples).where(eq(samples.hostId, hostId)).orderBy(desc(samples.ts)).limit(1)
      if (!latest) return null
      return (await pointsWhere(eq(samples.id, latest.id)))[0] ?? null
    },

    async getRecentEvents(hostId: string, limit = 20): Promise<UsageEvent[]> {
      const rows = await db.select().from(events).where(eq(events.hostId, hostId)).orderBy(desc(events.ts), desc(events.id)).limit(limit)
      return rows.map(r => ({
        kind: r.kind as UsageEvent['kind'], state: r.state as UsageEvent['state'], value: r.value, threshold: r.threshold,
        ts: r.ts.toISOString(), ...(r.mount ? { mount: r.mount } : {})
      }))
    },

    /** Deletes samples older than `cutoff` (their disk rows cascade) and returns how many samples were removed. */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const deleted = await db.delete(samples).where(lt(samples.ts, cutoff)).returning({ id: samples.id })
      logDebug('samples pruned', { cutoff: cutoff.toISOString(), deleted: deleted.length })
      return deleted.length
    },

    async pruneEventsOlderThan(cutoff: Date): Promise<number> {
      const deleted = await db.delete(events).where(lt(events.ts, cutoff)).returning({ id: events.id })
      logDebug('events pruned', { cutoff: cutoff.toISOString(), deleted: deleted.length })
      return deleted.length
    }
  }
}
```

- [ ] **Step 9: Run to see it pass** — with Postgres up: `npx vitest run tests/repository.test.ts tests/db.test.ts` → PASS. (The app's other files still import the deleted-soon collector/sampler; that is fixed in Task 9. `tests/sampler.test.ts`, `collector.test.ts` still pass because those files still exist.)

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: add host_id, events and hosts tables and per-host repository

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Event bus, retry helper, ingest handler

**Files (in `web/computer-usage/`):**
- Create: `server/utils/bus.ts`, `server/utils/retry.ts`, `server/utils/ingest.ts`
- Test: `tests/ingest.test.ts`, `tests/retry.test.ts`

**Interfaces:**
- Consumes: protocol parsers (Task 1), `createRepository` type (Task 7).
- Produces:
  - `BusEvent = { type: 'reading'; host: string; reading: Reading; requestId?: string; stored: boolean } | { type: 'event'; host: string; event: UsageEvent } | { type: 'status'; host: string; online: boolean } | { type: 'broker'; connected: boolean }`
  - `createBus(): Bus` with `emit(e)`, `subscribe(fn): () => void`; `bus` (HMR-safe singleton)
  - `withRetry(fn, { attempts, delayMs, onRetry? })`
  - `createIngest({ repo, bus, now? }): (topic: string, payload: Uint8Array | string) => Promise<void>` — validation problems are logged and dropped (resolve); database errors reject.

- [ ] **Step 1: Write the failing tests**

`tests/retry.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '../server/utils/retry'

describe('withRetry', () => {
  it('retries until it succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValue('ok')
    expect(await withRetry(fn, { attempts: 3, delayMs: 1 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('throws the last error after the attempts are used up', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'))
    await expect(withRetry(fn, { attempts: 2, delayMs: 1 })).rejects.toThrow('down')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
```

`tests/ingest.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBus, type BusEvent } from '../server/utils/bus'
import { createIngest } from '../server/utils/ingest'

const now = () => new Date('2026-01-01T12:00:00Z')
const reading = { ts: '2026-01-01T11:59:00Z', cpuPercent: 10, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }] }
const event = { kind: 'memory', state: 'alert', value: 93, threshold: 90, ts: '2026-01-01T11:59:00Z' }

let repo: { saveSample: any; saveEvent: any; touchHost: any }
let seen: BusEvent[]
let ingest: (t: string, p: string) => Promise<void>

beforeEach(() => {
  repo = { saveSample: vi.fn().mockResolvedValue(1), saveEvent: vi.fn().mockResolvedValue(true), touchHost: vi.fn().mockResolvedValue(undefined) }
  const bus = createBus()
  seen = []
  bus.subscribe(e => seen.push(e))
  ingest = createIngest({ repo, bus, now })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('heartbeat', () => {
  it('stores the reading, marks the host online and emits it', async () => {
    await ingest('computer-usage/web-01/heartbeat', JSON.stringify(reading))
    expect(repo.touchHost).toHaveBeenCalledWith('web-01', { online: true }, now())
    expect(repo.saveSample).toHaveBeenCalledWith('web-01', reading)
    expect(seen).toEqual([{ type: 'reading', host: 'web-01', reading, stored: true }])
  })
  it('does not emit again for a duplicate delivery', async () => {
    repo.saveSample.mockResolvedValue(null)
    await ingest('computer-usage/web-01/heartbeat', JSON.stringify(reading))
    expect(seen).toEqual([])
  })
  it('drops garbage without storing, throwing or emitting', async () => {
    for (const payload of ['not json', '{}', JSON.stringify({ ...reading, cpuPercent: 250 }), JSON.stringify({ ...reading, memUsed: -1 })]) {
      await expect(ingest('computer-usage/web-01/heartbeat', payload)).resolves.toBeUndefined()
    }
    expect(repo.saveSample).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })
  it('rejects a timestamp more than 5 minutes in the future', async () => {
    await ingest('computer-usage/web-01/heartbeat', JSON.stringify({ ...reading, ts: '2026-01-02T00:00:00Z' }))
    expect(repo.saveSample).not.toHaveBeenCalled()
  })
  it('lets database errors propagate so the caller can retry', async () => {
    repo.saveSample.mockRejectedValue(new Error('db down'))
    await expect(ingest('computer-usage/web-01/heartbeat', JSON.stringify(reading))).rejects.toThrow('db down')
  })
})

describe('event', () => {
  it('stores and emits an event, once', async () => {
    await ingest('computer-usage/web-01/event', JSON.stringify(event))
    expect(repo.saveEvent).toHaveBeenCalledWith('web-01', event)
    expect(seen).toEqual([{ type: 'event', host: 'web-01', event }])
    repo.saveEvent.mockResolvedValue(false)
    seen.length = 0
    await ingest('computer-usage/web-01/event', JSON.stringify(event))
    expect(seen).toEqual([])
  })
  it('drops an event with an unknown kind', async () => {
    await ingest('computer-usage/web-01/event', JSON.stringify({ ...event, kind: 'gpu' }))
    expect(repo.saveEvent).not.toHaveBeenCalled()
  })
})

describe('check reply', () => {
  it('is forwarded with its request id but never stored', async () => {
    await ingest('computer-usage/web-01/reading', JSON.stringify({ ...reading, requestId: 'r1' }))
    expect(repo.saveSample).not.toHaveBeenCalled()
    expect(seen).toEqual([{ type: 'reading', host: 'web-01', reading, requestId: 'r1', stored: false }])
  })
})

describe('status', () => {
  it('records online/offline and emits it', async () => {
    await ingest('computer-usage/web-01/status', JSON.stringify({ state: 'offline' }))
    expect(repo.touchHost).toHaveBeenCalledWith('web-01', { online: false }, now())
    expect(seen).toEqual([{ type: 'status', host: 'web-01', online: false }])
  })
})

describe('topics', () => {
  it('ignores unknown or hostile topics and our own check topic', async () => {
    for (const t of ['other/web-01/heartbeat', 'computer-usage/+/heartbeat', 'computer-usage/a/b/heartbeat', 'computer-usage/web-01/check']) {
      await expect(ingest(t, JSON.stringify(reading))).resolves.toBeUndefined()
    }
    expect(repo.saveSample).not.toHaveBeenCalled()
    expect(repo.touchHost).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run tests/retry.test.ts tests/ingest.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`server/utils/retry.ts`:
```ts
/** Runs `fn`, retrying after `delayMs` on failure; the last error is thrown once `attempts` are used up. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts, delayMs, onRetry }: { attempts: number; delayMs: number; onRetry?: (err: unknown, attempt: number) => void }
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts) throw err
      onRetry?.(err, attempt)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}
```

`server/utils/bus.ts`:
```ts
import type { Reading, UsageEvent } from 'computer-usage-agent/protocol'

export type BusEvent =
  | { type: 'reading'; host: string; reading: Reading; requestId?: string; stored: boolean }
  | { type: 'event'; host: string; event: UsageEvent }
  | { type: 'status'; host: string; online: boolean }
  | { type: 'broker'; connected: boolean }

export interface Bus {
  emit(e: BusEvent): void
  subscribe(fn: (e: BusEvent) => void): () => void
}

export function createBus(): Bus {
  const listeners = new Set<(e: BusEvent) => void>()
  return {
    emit(e) { for (const fn of listeners) { try { fn(e) } catch { /* one broken listener must not stop the others */ } } },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }
  }
}

// One bus per process, kept across dev HMR reloads so open SSE connections stay subscribed.
const g = globalThis as { __computerUsageBus?: Bus }
export const bus: Bus = (g.__computerUsageBus ??= createBus())
```

`server/utils/ingest.ts`:
```ts
import { decodePayload, parseCheckReply, parseEvent, parseReading, parseStatus, parseTopic } from 'computer-usage-agent/protocol'
import type { Bus } from './bus'
import { logDebug, logError } from './log'
import type { createRepository } from './repository'

type Repo = Pick<ReturnType<typeof createRepository>, 'saveSample' | 'saveEvent' | 'touchHost'>

const MAX_FUTURE_MS = 5 * 60_000
const preview = (p: Uint8Array | string) => (typeof p === 'string' ? p : new TextDecoder().decode(p)).slice(0, 200)

/**
 * Handles one MQTT message. Validation problems are logged and dropped (the promise resolves);
 * database errors reject so the caller can retry.
 */
export function createIngest({ repo, bus, now = () => new Date() }: { repo: Repo; bus: Bus; now?: () => Date }) {
  const reject = (reason: string, topic: string, payload: Uint8Array | string) => {
    logError('mqtt message rejected', { reason, topic, payload: preview(payload) })
  }
  const tooNew = (ts: string) => Date.parse(ts) > now().getTime() + MAX_FUTURE_MS

  return async function ingest(topic: string, payload: Uint8Array | string): Promise<void> {
    const t = parseTopic(topic)
    if (!t) return reject('unknown topic', topic, payload)
    const { host } = t
    const body = decodePayload(payload)

    switch (t.type) {
      case 'heartbeat': {
        const reading = parseReading(body)
        if (!reading) return reject('invalid reading', topic, payload)
        if (tooNew(reading.ts)) return reject('timestamp too far in the future', topic, payload)
        await repo.touchHost(host, { online: true }, now())
        const id = await repo.saveSample(host, reading)
        if (id !== null) bus.emit({ type: 'reading', host, reading, stored: true })
        return
      }
      case 'event': {
        const event = parseEvent(body)
        if (!event) return reject('invalid event', topic, payload)
        if (tooNew(event.ts)) return reject('timestamp too far in the future', topic, payload)
        await repo.touchHost(host, { online: true }, now())
        if (await repo.saveEvent(host, event)) bus.emit({ type: 'event', host, event })
        return
      }
      case 'reading': {
        const reply = parseCheckReply(body)
        if (!reply) return reject('invalid check reply', topic, payload)
        if (tooNew(reply.ts)) return reject('timestamp too far in the future', topic, payload)
        const { requestId, ...reading } = reply
        await repo.touchHost(host, { online: true }, now())
        bus.emit({ type: 'reading', host, reading, requestId, stored: false })
        return
      }
      case 'status': {
        const status = parseStatus(body)
        if (!status) return reject('invalid status', topic, payload)
        const online = status.state === 'online'
        await repo.touchHost(host, { online }, now())
        bus.emit({ type: 'status', host, online })
        return
      }
      default:
        logDebug('mqtt message ignored', { topic })
    }
  }
}
```

- [ ] **Step 4: Run to see them pass** — `npx vitest run tests/retry.test.ts tests/ingest.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add event bus, retry helper and MQTT ingest handler

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: MQTT connection plugin; replace the sampler

**Files (in `web/computer-usage/`):**
- Create: `server/utils/ready.ts`, `server/utils/mqtt.ts`, `server/plugins/mqtt.ts`, `server/plugins/retention.ts`
- Test: `tests/ready.test.ts`, `tests/mqtt-config.test.ts`
- Delete: `server/plugins/sampler.ts`, `server/utils/sampler.ts`, `server/utils/collector.ts`, `tests/sampler.test.ts`, `tests/collector.test.ts`

**Interfaces:**
- Consumes: `createIngest`, `bus`, `withRetry`, `createRepository`, `createPruner`, `parseRetentionDays`, `PRUNE_INTERVAL_MS`, `getDb`, `runMigrations`.
- Produces: `memoizeUntilFailure`, `ensureDbReady()` (ready.ts); `MqttConfig`, `readMqttConfig(env)`, `isBrokerConnected(): boolean`, `publishCheck(host, requestId): Promise<void>`, `registerMqttClient(client)` (mqtt.ts).

- [ ] **Step 1: Write the failing tests**

`tests/ready.test.ts` (the `memoizeUntilFailure` test moved from `sampler.test.ts`):
```ts
import { describe, expect, it, vi } from 'vitest'
import { memoizeUntilFailure } from '../server/utils/ready'

describe('memoizeUntilFailure', () => {
  it('runs once on success and again after a failure', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined)
    const once = memoizeUntilFailure(fn)
    await expect(once()).rejects.toThrow('x')
    await once()
    await once()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
```

`tests/mqtt-config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { readMqttConfig } from '../server/utils/mqtt'

describe('readMqttConfig', () => {
  it('applies defaults', () => {
    expect(readMqttConfig({})).toEqual({ url: 'mqtt://localhost:1883', username: 'app', password: undefined, heartbeatIntervalMs: 300000 })
  })
  it('reads overrides and ignores an invalid heartbeat interval', () => {
    expect(readMqttConfig({ MQTT_URL: 'mqtt://b:1', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p', HEARTBEAT_INTERVAL_MS: '1000' }))
      .toEqual({ url: 'mqtt://b:1', username: 'u', password: 'p', heartbeatIntervalMs: 1000 })
    expect(readMqttConfig({ HEARTBEAT_INTERVAL_MS: 'x' }).heartbeatIntervalMs).toBe(300000)
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run tests/ready.test.ts tests/mqtt-config.test.ts` → FAIL.

- [ ] **Step 3: Implement the utilities**

`server/utils/ready.ts`:
```ts
import { getDb } from '../db'
import { runMigrations } from '../db/migrate'

/** Runs `fn` until it succeeds once; concurrent callers share the in-flight run, failures are not cached. */
export function memoizeUntilFailure(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= fn().catch((err) => { pending = undefined; throw err })
    return pending
  }
}

/** Migrations are retried on every call until they succeed, so starting the app before Postgres is up self-heals. */
export const ensureDbReady = memoizeUntilFailure(() => runMigrations(getDb()))
```

`server/utils/mqtt.ts`:
```ts
import type { MqttClient } from 'mqtt'
import { topic } from 'computer-usage-agent/protocol'

export interface MqttConfig { url: string; username?: string; password?: string; heartbeatIntervalMs: number }

export function readMqttConfig(env: Record<string, string | undefined>): MqttConfig {
  const hb = Number(env.HEARTBEAT_INTERVAL_MS)
  return {
    url: env.MQTT_URL || 'mqtt://localhost:1883',
    username: env.MQTT_USERNAME || 'app',
    password: env.MQTT_PASSWORD || undefined,
    heartbeatIntervalMs: Number.isFinite(hb) && hb > 0 ? hb : 300_000
  }
}

// One client per process, kept across dev HMR reloads.
const g = globalThis as { __computerUsageMqtt?: { client: MqttClient; connected: boolean } }

export function registerMqttClient(client: MqttClient): void {
  g.__computerUsageMqtt?.client.end(true)
  g.__computerUsageMqtt = { client, connected: false }
}
export function setBrokerConnected(connected: boolean): void {
  if (g.__computerUsageMqtt) g.__computerUsageMqtt.connected = connected
}
export const isBrokerConnected = (): boolean => g.__computerUsageMqtt?.connected ?? false

export async function publishCheck(host: string, requestId: string): Promise<void> {
  const state = g.__computerUsageMqtt
  if (!state?.connected) throw new Error('MQTT broker is not connected')
  await state.client.publishAsync(topic(host, 'check'), JSON.stringify({ requestId }), { qos: 1 })
}
```

- [ ] **Step 4: Run to see them pass** — `npx vitest run tests/ready.test.ts tests/mqtt-config.test.ts` → PASS.

- [ ] **Step 5: Create `server/plugins/mqtt.ts`**

```ts
import mqtt from 'mqtt'
import { TOPIC_ROOT } from 'computer-usage-agent/protocol'
import { getDb } from '../db'
import { bus } from '../utils/bus'
import { createIngest } from '../utils/ingest'
import { logDebug, logError, logInfo } from '../utils/log'
import { readMqttConfig, registerMqttClient, setBrokerConnected } from '../utils/mqtt'
import { ensureDbReady } from '../utils/ready'
import { createRepository } from '../utils/repository'
import { withRetry } from '../utils/retry'

const SUBSCRIPTIONS = ['heartbeat', 'event', 'reading', 'status'].map(t => `${TOPIC_ROOT}/+/${t}`)
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default defineNitroPlugin((nitroApp) => {
  const cfg = readMqttConfig(process.env)
  const ingest = createIngest({ repo: createRepository(getDb()), bus })

  // Persistent session + QoS 1: the broker queues messages meant for us while the app is down.
  const client = mqtt.connect(cfg.url, {
    clientId: 'computer-usage-app',
    clean: false,
    reconnectPeriod: 2000,
    username: cfg.username,
    password: cfg.password
  })
  registerMqttClient(client)

  client.on('connect', () => {
    setBrokerConnected(true)
    bus.emit({ type: 'broker', connected: true })
    logInfo('connected to MQTT broker', { url: cfg.url })
    client.subscribe(SUBSCRIPTIONS, { qos: 1 }, (err) => { if (err) logError('mqtt subscribe failed', { topics: SUBSCRIPTIONS, error: errMsg(err) }) })
  })
  client.on('close', () => {
    setBrokerConnected(false)
    bus.emit({ type: 'broker', connected: false })
    logDebug('mqtt connection closed')
  })
  client.on('error', err => logError('mqtt error', { url: cfg.url, error: errMsg(err) }))

  // Messages are handled one at a time, in arrival order. A database outage is retried for ~10 s before a message is dropped.
  let chain: Promise<void> = Promise.resolve()
  client.on('message', (topic, payload) => {
    chain = chain
      .then(() => withRetry(async () => { await ensureDbReady(); await ingest(topic, payload) }, {
        attempts: 5,
        delayMs: 2000,
        onRetry: (err, attempt) => logError('ingest failed, retrying', { topic, attempt, error: errMsg(err) })
      }))
      .catch(err => logError('ingest failed, message dropped', { topic, error: errMsg(err) }))
  })

  nitroApp.hooks.hook('close', () => { client.end(true) })
})
```

- [ ] **Step 6: Create `server/plugins/retention.ts`** (the pruning wiring that lived in `sampler.ts`)

```ts
import { getDb } from '../db'
import { logInfo } from '../utils/log'
import { ensureDbReady } from '../utils/ready'
import { createRepository } from '../utils/repository'
import { createPruner, parseRetentionDays, PRUNE_INTERVAL_MS } from '../utils/retention'

const g = globalThis as { __computerUsagePruneTimer?: NodeJS.Timeout }

export default defineNitroPlugin((nitroApp) => {
  if (g.__computerUsagePruneTimer) clearInterval(g.__computerUsagePruneTimer) // dev HMR safety

  const repo = createRepository(getDb())
  const retentionDays = parseRetentionDays(process.env.RETENTION_DAYS)
  const prune = createPruner({
    retentionDays,
    ensureReady: ensureDbReady,
    prune: async (cutoff) => {
      const samples = await repo.pruneOlderThan(cutoff)
      await repo.pruneEventsOlderThan(cutoff)
      return samples
    }
  })
  void prune()
  g.__computerUsagePruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS)
  logInfo('retention configured', { retentionDays, enabled: retentionDays > 0 })

  nitroApp.hooks.hook('close', () => {
    if (g.__computerUsagePruneTimer) clearInterval(g.__computerUsagePruneTimer)
    g.__computerUsagePruneTimer = undefined
  })
})
```

- [ ] **Step 7: Delete the in-process sampler and local collector**

```bash
git rm server/plugins/sampler.ts server/utils/sampler.ts server/utils/collector.ts tests/sampler.test.ts tests/collector.test.ts
```
(`systeminformation` can stay in `package.json` for now; remove it with `npm uninstall systeminformation` only after `grep -r systeminformation server app` finds nothing.)

- [ ] **Step 8: Run the unit tests** — `npx vitest run tests/ready.test.ts tests/mqtt-config.test.ts tests/retry.test.ts tests/ingest.test.ts tests/retention.test.ts tests/series.test.ts tests/range.test.ts tests/log.test.ts` → PASS. (The API routes still reference the old repository signatures until Task 10, so do not run `nuxt build` yet.)

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: replace in-process sampler with MQTT ingest plugin

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: API routes and Check-now logic

**Files (in `web/computer-usage/`):**
- Create: `server/utils/check.ts`, `server/utils/host.ts`, `server/api/stream.get.ts`, `server/api/hosts/index.get.ts`, `server/api/hosts/[host]/check.post.ts`, `server/api/events.get.ts`
- Modify: `server/api/metrics/history.get.ts`, `server/api/metrics/current.get.ts`
- Test: `tests/check.test.ts`, `tests/host.test.ts`

**Interfaces:**
- Consumes: repository (Task 7), `bus` (Task 8), `isBrokerConnected`, `publishCheck`, `readMqttConfig` (Task 9), `isValidHostId`.
- Produces:
  - `createCheckRequester({ publish, now?, cooldownMs?, newId? }): (host: string) => Promise<{ ok: true; requestId: string } | { ok: false; reason: 'cooldown' }>`
  - `resolveHost(raw: unknown, known: string[]): { ok: true; host: string | null } | { ok: false }`
  - HTTP: `GET /api/hosts` → `{ hosts: HostRow[]; brokerConnected: boolean; staleAfterMs: number }`; `POST /api/hosts/:host/check` → `{ requestId }` (400 bad host, 429 cooldown, 503 broker down); `GET /api/events?host=&limit=` → `UsageEvent[]`; `GET /api/metrics/history?range=&host=` → `Reading[]`; `GET /api/metrics/current?host=` → `Reading | null`; `GET /api/stream` → SSE of `BusEvent` JSON plus `{type:'ping'}`.

- [ ] **Step 1: Write the failing tests**

`tests/check.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { createCheckRequester } from '../server/utils/check'

describe('createCheckRequester', () => {
  it('publishes a request with a fresh id', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const check = createCheckRequester({ publish, newId: () => 'id-1' })
    expect(await check('h1')).toEqual({ ok: true, requestId: 'id-1' })
    expect(publish).toHaveBeenCalledWith('h1', 'id-1')
  })
  it('refuses a second request for the same host within the cooldown, but not for other hosts or later', async () => {
    let t = 1000
    const publish = vi.fn().mockResolvedValue(undefined)
    const check = createCheckRequester({ publish, now: () => t, cooldownMs: 2000 })
    expect((await check('h1')).ok).toBe(true)
    expect(await check('h1')).toEqual({ ok: false, reason: 'cooldown' })
    expect((await check('h2')).ok).toBe(true)
    t += 2001
    expect((await check('h1')).ok).toBe(true)
    expect(publish).toHaveBeenCalledTimes(3)
  })
  it('does not start a cooldown when publishing fails', async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined)
    const check = createCheckRequester({ publish })
    await expect(check('h1')).rejects.toThrow('down')
    expect((await check('h1')).ok).toBe(true)
  })
})
```

`tests/host.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { resolveHost } from '../server/utils/host'

describe('resolveHost', () => {
  it('uses the requested host when valid', () => {
    expect(resolveHost('web-01', ['a', 'b'])).toEqual({ ok: true, host: 'web-01' })
  })
  it('defaults to the first known host, or null when there are none', () => {
    expect(resolveHost(undefined, ['a', 'b'])).toEqual({ ok: true, host: 'a' })
    expect(resolveHost(undefined, [])).toEqual({ ok: true, host: null })
  })
  it('rejects hostile or malformed ids', () => {
    for (const h of ['a/b', '+', '#', '', 'x'.repeat(65), 5, ['a']]) expect(resolveHost(h, ['a'])).toEqual({ ok: false })
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run tests/check.test.ts tests/host.test.ts` → FAIL.

- [ ] **Step 3: Implement the helpers**

`server/utils/check.ts`:
```ts
import { randomUUID } from 'node:crypto'

interface Deps {
  publish: (host: string, requestId: string) => Promise<void>
  now?: () => number
  cooldownMs?: number
  newId?: () => string
}

/** Sends "check now" requests, at most one per host per cooldown so repeated clicks cannot flood a machine. */
export function createCheckRequester({ publish, now = Date.now, cooldownMs = 2000, newId = randomUUID }: Deps) {
  const lastAt = new Map<string, number>()
  return async (host: string): Promise<{ ok: true; requestId: string } | { ok: false; reason: 'cooldown' }> => {
    const t = now()
    const prev = lastAt.get(host)
    if (prev !== undefined && t - prev < cooldownMs) return { ok: false, reason: 'cooldown' }
    lastAt.set(host, t)
    const requestId = newId()
    try {
      await publish(host, requestId)
    } catch (err) {
      if (lastAt.get(host) === t) lastAt.delete(host)
      throw err
    }
    return { ok: true, requestId }
  }
}
```

`server/utils/host.ts`:
```ts
import { isValidHostId } from 'computer-usage-agent/protocol'

/** Picks the host a request is about: the given one if valid, else the first known host (null when none exist yet). */
export function resolveHost(raw: unknown, known: string[]): { ok: true; host: string | null } | { ok: false } {
  if (raw === undefined) return { ok: true, host: known[0] ?? null }
  return isValidHostId(raw) ? { ok: true, host: raw } : { ok: false }
}
```

- [ ] **Step 4: Run to see them pass** — `npx vitest run tests/check.test.ts tests/host.test.ts` → PASS.

- [ ] **Step 5: Write the routes**

`server/api/hosts/index.get.ts`:
```ts
import { getDb } from '../../db'
import { logError } from '../../utils/log'
import { isBrokerConnected, readMqttConfig } from '../../utils/mqtt'
import { createRepository } from '../../utils/repository'

export default defineEventHandler(async () => {
  try {
    const hosts = await createRepository(getDb()).listHosts()
    return { hosts, brokerConnected: isBrokerConnected(), staleAfterMs: readMqttConfig(process.env).heartbeatIntervalMs * 2 }
  } catch (err) {
    logError('hosts query failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read hosts' })
  }
})
```

`server/api/hosts/[host]/check.post.ts`:
```ts
import { isValidHostId } from 'computer-usage-agent/protocol'
import { createCheckRequester } from '../../../utils/check'
import { logDebug, logError } from '../../../utils/log'
import { isBrokerConnected, publishCheck } from '../../../utils/mqtt'

const requestCheck = createCheckRequester({ publish: publishCheck })

export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
  if (!isBrokerConnected()) throw createError({ statusCode: 503, statusMessage: 'MQTT broker is not connected' })
  try {
    const result = await requestCheck(host)
    if (!result.ok) throw createError({ statusCode: 429, statusMessage: 'Check requested too recently' })
    logDebug('check requested', { host, requestId: result.requestId })
    return { requestId: result.requestId }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('check request failed', { host, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not send the check request' })
  }
})
```

`server/api/events.get.ts`:
```ts
import { getDb } from '../db'
import { resolveHost } from '../utils/host'
import { logError } from '../utils/log'
import { createRepository } from '../utils/repository'

export default defineEventHandler(async (event) => {
  const repo = createRepository(getDb())
  const q = getQuery(event)
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20))
  try {
    const resolved = resolveHost(q.host, (await repo.listHosts()).map(h => h.hostId))
    if (!resolved.ok) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
    return resolved.host ? await repo.getRecentEvents(resolved.host, limit) : []
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('events query failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read events' })
  }
})
```

`server/api/metrics/history.get.ts`:
```ts
import { getDb } from '../../db'
import { resolveHost } from '../../utils/host'
import { logDebug, logError } from '../../utils/log'
import { parseRange } from '../../utils/range'
import { createRepository } from '../../utils/repository'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const range = parseRange(q.range)
  if (!range) throw createError({ statusCode: 400, statusMessage: 'range must be one of 1h, 24h, 7d' })
  const repo = createRepository(getDb())
  try {
    const resolved = resolveHost(q.host, (await repo.listHosts()).map(h => h.hostId))
    if (!resolved.ok) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
    if (!resolved.host) return []
    const rows = await repo.getHistory(resolved.host, range)
    logDebug('history served', { host: resolved.host, range, rows: rows.length })
    return rows
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('history query failed', { range, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read history' })
  }
})
```

`server/api/metrics/current.get.ts`:
```ts
import { getDb } from '../../db'
import { resolveHost } from '../../utils/host'
import { logError } from '../../utils/log'
import { createRepository } from '../../utils/repository'

/** Latest stored reading for the host, or null before the first heartbeat arrives. */
export default defineEventHandler(async (event) => {
  const repo = createRepository(getDb())
  try {
    const resolved = resolveHost(getQuery(event).host, (await repo.listHosts()).map(h => h.hostId))
    if (!resolved.ok) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
    return resolved.host ? await repo.getLatest(resolved.host) : null
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('current metrics failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read system metrics' })
  }
})
```

`server/api/stream.get.ts`:
```ts
import { createEventStream } from 'h3'
import { bus } from '../utils/bus'
import { logDebug } from '../utils/log'
import { isBrokerConnected } from '../utils/mqtt'

const PING_MS = 25_000

export default defineEventHandler(async (event) => {
  const stream = createEventStream(event)
  const unsubscribe = bus.subscribe((e) => { void stream.push(JSON.stringify(e)) })
  const ping = setInterval(() => void stream.push(JSON.stringify({ type: 'ping' })), PING_MS)
  stream.onClosed(async () => {
    clearInterval(ping)
    unsubscribe()
    logDebug('stream closed')
    await stream.close()
  })
  logDebug('stream opened')
  void stream.push(JSON.stringify({ type: 'broker', connected: isBrokerConnected() }))
  return stream.send()
})
```

- [ ] **Step 6: Verify the build compiles** — `npx nuxt build 2>&1 | grep -iE "error|unresolved|cannot"` (ignore the `error-404/500` asset names). Expected: no errors. This also proves Nitro bundles `computer-usage-agent/protocol`. If it fails with an `.ts` import error from `computer-usage-agent`, adjust the `nitro.externals.inline` / `build.transpile` entries in `nuxt.config.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add host, event, check and SSE stream API routes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Stage 3 — Broker and dashboard

### Task 11: Mosquitto in docker-compose

**Files (in `web/computer-usage/`):**
- Create: `docker/mosquitto/mosquitto.conf`, `docker/mosquitto/acl`, `docker/mosquitto/add-user.sh`
- Modify: `docker-compose.yml`, `.gitignore`, `.env.example`, `package.json` (script)

**Interfaces:**
- Produces: a broker on `localhost:1883` with password auth and an ACL; credentials for user `app` (the Nuxt app) and one user per agent whose username equals its `HOST_ID`.

- [ ] **Step 1: Create the broker config**

`docker/mosquitto/mosquitto.conf`:
```
listener 1883
allow_anonymous false
password_file /mosquitto/config/passwd
acl_file /mosquitto/config/acl
persistence true
persistence_location /mosquitto/data/
max_queued_messages 5000
```

`docker/mosquitto/acl`:
```
# The app reads everything and may publish "check now" requests.
user app
topic read computer-usage/#
topic write computer-usage/+/check

# Every other user is an agent whose username is its HOST_ID: it may only publish under its own host
# topic and read its own check topic.
pattern write computer-usage/%u/#
pattern read computer-usage/%u/check
```

`docker/mosquitto/add-user.sh` (then `chmod +x`):
```bash
#!/usr/bin/env bash
# Usage: docker/mosquitto/add-user.sh <username> <password>
# Adds or updates a broker user. For agents the username must equal the agent's HOST_ID.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <username> <password>" >&2; exit 1; }
dir="$(cd "$(dirname "$0")" && pwd)"
touch "$dir/passwd"
docker run --rm --user "$(id -u):$(id -g)" -v "$dir":/work eclipse-mosquitto:2 mosquitto_passwd -b /work/passwd "$1" "$2"
chmod 0644 "$dir/passwd"
echo "user '$1' saved in $dir/passwd; restart the broker: docker compose restart mosquitto"
```

- [ ] **Step 2: Add the service** — replace `docker-compose.yml` with:

```yaml
services:
  postgres:
    image: postgres:18
    container_name: computer-usage-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: computer-usage
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql
      - ./docker/init-db.sql:/docker-entrypoint-initdb.d/init-db.sql:ro
  mosquitto:
    image: eclipse-mosquitto:2
    container_name: computer-usage-mqtt
    restart: unless-stopped
    ports:
      - "1883:1883"
    volumes:
      - ./docker/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - ./docker/mosquitto/acl:/mosquitto/config/acl:ro
      - ./docker/mosquitto/passwd:/mosquitto/config/passwd:ro
      - mqttdata:/mosquitto/data
volumes:
  pgdata:
  mqttdata:
```

- [ ] **Step 3: Ignore the password file; extend `.env.example`**

Append `docker/mosquitto/passwd` to `.gitignore`. Replace `.env.example` with:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5433/computer-usage
MQTT_URL=mqtt://localhost:1883
MQTT_USERNAME=app
MQTT_PASSWORD=changeme-app
HEARTBEAT_INTERVAL_MS=300000
RETENTION_DAYS=30
NUXT_ADD_DEBUG_LOGS=false
```
(`SAMPLE_INTERVAL_MS` is gone: the app no longer samples.)

In `package.json` scripts add: `"agent": "npm --prefix ../lib/computer-usage-agent start"`.

- [ ] **Step 4: Verify the broker (needs Docker)**

```bash
chmod +x docker/mosquitto/add-user.sh
docker/mosquitto/add-user.sh app changeme-app
docker/mosquitto/add-user.sh local changeme-local
docker compose up -d
docker logs computer-usage-mqtt 2>&1 | tail -5     # expect "mosquitto version 2.x running"
```
Then confirm the ACL: an agent user can publish under its own topic but not another host's:
```bash
docker exec computer-usage-mqtt mosquitto_pub -h localhost -u local -P changeme-local -t computer-usage/local/status -m '{"state":"online"}' && echo own-topic-ok
docker exec computer-usage-mqtt mosquitto_pub -h localhost -u local -P changeme-local -t computer-usage/other/status -m '{"state":"online"}'; echo "exit=$?"
```
Expected: the first prints `own-topic-ok`. For the second, mosquitto (MQTT 3.1.1) silently drops denied publishes, so confirm with a subscriber: `docker exec computer-usage-mqtt mosquitto_sub -h localhost -u app -P changeme-app -t 'computer-usage/#' -v -W 3` run while publishing; the `other` message must not appear. If Docker is unavailable, say the broker config is unverified.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "config: add Mosquitto broker with per-agent ACL

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Dashboard helpers (alerts and staleness)

**Files (in `web/computer-usage/`):**
- Create: `app/utils/alerts.ts`
- Test: `tests/alerts.test.ts`

**Interfaces:**
- Consumes: `UsageEvent` shape from `computer-usage-agent/protocol`.
- Produces: `activeAlerts(events: UsageEvent[]): UsageEvent[]`, `isStale(lastSeen: string | undefined, now: number, staleAfterMs: number): boolean`, `describeAlert(e: UsageEvent): string`.

- [ ] **Step 1: Write the failing test** — `tests/alerts.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { activeAlerts, describeAlert, isStale } from '../app/utils/alerts'

const e = (kind: 'cpu' | 'memory' | 'disk', state: 'alert' | 'ok', ts: string, mount?: string) =>
  ({ kind, state, value: 95, threshold: 90, ts, ...(mount ? { mount } : {}) })

describe('activeAlerts', () => {
  it('keeps the latest event per kind and mount, and returns only those still alerting', () => {
    const list = [
      e('memory', 'alert', '2026-01-01T10:00:00Z'),
      e('memory', 'ok', '2026-01-01T11:00:00Z'),
      e('cpu', 'alert', '2026-01-01T10:30:00Z'),
      e('disk', 'alert', '2026-01-01T09:00:00Z', '/'),
      e('disk', 'alert', '2026-01-01T09:30:00Z', '/data'),
      e('disk', 'ok', '2026-01-01T10:00:00Z', '/data')
    ]
    expect(activeAlerts(list).map(a => `${a.kind}${a.mount ?? ''}`).sort()).toEqual(['cpu', 'disk/'])
  })
  it('does not depend on the input order', () => {
    const list = [e('cpu', 'ok', '2026-01-01T11:00:00Z'), e('cpu', 'alert', '2026-01-01T10:00:00Z')]
    expect(activeAlerts(list)).toEqual([])
    expect(activeAlerts([...list].reverse())).toEqual([])
  })
})

describe('isStale', () => {
  it('is stale when nothing was ever seen or the last message is older than the limit', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    expect(isStale(undefined, now, 600_000)).toBe(true)
    expect(isStale('2026-01-01T11:49:00Z', now, 600_000)).toBe(true)
    expect(isStale('2026-01-01T11:55:00Z', now, 600_000)).toBe(false)
  })
})

describe('describeAlert', () => {
  it('writes a readable sentence for each kind', () => {
    expect(describeAlert(e('cpu', 'alert', 't'))).toBe('CPU at 95% (threshold 90%)')
    expect(describeAlert(e('memory', 'alert', 't'))).toBe('Memory at 95% (threshold 90%)')
    expect(describeAlert(e('disk', 'alert', 't', '/data'))).toBe('Disk /data at 95% (threshold 90%)')
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run tests/alerts.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `app/utils/alerts.ts`

```ts
import type { UsageEvent } from 'computer-usage-agent/protocol'

const key = (e: Pick<UsageEvent, 'kind' | 'mount'>) => `${e.kind}:${e.mount ?? ''}`

/** The alerts still open: the newest event per kind (and disk mount), kept only if that event is an alert. */
export function activeAlerts(events: UsageEvent[]): UsageEvent[] {
  const latest = new Map<string, UsageEvent>()
  for (const e of events) {
    const prev = latest.get(key(e))
    if (!prev || Date.parse(e.ts) >= Date.parse(prev.ts)) latest.set(key(e), e)
  }
  return [...latest.values()].filter(e => e.state === 'alert')
}

/** A host is stale when nothing (heartbeat, event or status) arrived for longer than `staleAfterMs`. */
export const isStale = (lastSeen: string | undefined, now: number, staleAfterMs: number): boolean =>
  !lastSeen || now - Date.parse(lastSeen) > staleAfterMs

export function describeAlert(e: UsageEvent): string {
  const what = e.kind === 'cpu' ? 'CPU' : e.kind === 'memory' ? 'Memory' : `Disk ${e.mount}`
  return `${what} at ${Math.round(e.value)}% (threshold ${e.threshold}%)`
}
```

- [ ] **Step 4: Run to see it pass** — `npx vitest run tests/alerts.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add alert and staleness helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Dashboard page (host picker, live stream, alerts, Check now)

**Files (in `web/computer-usage/`):**
- Modify: `app/pages/index.vue` (rewrite), `app/components/UsageChart.vue` (empty-state text)

**Interfaces:**
- Consumes: `/api/hosts`, `/api/metrics/current`, `/api/metrics/history`, `/api/events`, `POST /api/hosts/:host/check`, `/api/stream`; helpers `appendLive`, `withLive`, `diskSeries`, `formatBytes` (existing, `app/utils/series.ts`) and `activeAlerts`, `isStale`, `describeAlert` (Task 12).

- [ ] **Step 1: Update the chart empty-state** — in `app/components/UsageChart.vue` replace the text `Not enough data yet — samples are taken every minute.` with `Not enough data yet — a reading arrives every few minutes, or click Check now.`

- [ ] **Step 2: Rewrite `app/pages/index.vue`**

```vue
<script setup lang="ts">
import type { Reading, UsageEvent } from 'computer-usage-agent/protocol'

type HostInfo = { hostId: string; online: boolean; lastSeen: string }
type HostsResponse = { hosts: HostInfo[]; brokerConnected: boolean; staleAfterMs: number }
type BusMessage =
  | { type: 'reading'; host: string; reading: Reading; requestId?: string; stored: boolean }
  | { type: 'event'; host: string; event: UsageEvent }
  | { type: 'status'; host: string; online: boolean }
  | { type: 'broker'; connected: boolean }
  | { type: 'ping' }

const MAX_LIVE_POINTS = 720
const CHECK_TIMEOUT_MS = 10_000
const MAX_EVENTS = 50

const range = ref<'1h' | '24h' | '7d'>('1h')
const { data: hostsData, refresh: refreshHosts } = await useFetch<HostsResponse>('/api/hosts')
const host = ref<string | undefined>(hostsData.value?.hosts[0]?.hostId)
const { data: current, error: currentError, refresh: refreshCurrent } = await useFetch<Reading | null>('/api/metrics/current', { query: { host } })
const { data: history, refresh: refreshHistory } = await useFetch<Reading[]>('/api/metrics/history', { query: { range, host } })
const { data: events, refresh: refreshEvents } = await useFetch<UsageEvent[]>('/api/events', { query: { host } })

// Points received over the stream, merged after the stored history so charts move between database re-syncs.
const live = ref<Reading[]>([])
watch([range, host], () => { live.value = [] })

const brokerConnected = ref(hostsData.value?.brokerConnected ?? false)
const streamUp = ref(true)
const now = ref(Date.now())

const checking = ref(false)
const checkMessage = ref('')
let pendingRequestId: string | undefined
let checkTimer: ReturnType<typeof setTimeout> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let source: EventSource | undefined

const selectedHost = computed(() => hostsData.value?.hosts.find(h => h.hostId === host.value))
const stale = computed(() => !!selectedHost.value && isStale(selectedHost.value.lastSeen, now.value, hostsData.value?.staleAfterMs ?? 600_000))
const hostStatus = computed(() => {
  if (!selectedHost.value) return ''
  if (stale.value) return 'no recent data'
  return selectedHost.value.online ? 'online' : 'offline'
})
const alerts = computed(() => activeAlerts(events.value ?? []))

function finishCheck(message = '') {
  clearTimeout(checkTimer)
  pendingRequestId = undefined
  checking.value = false
  checkMessage.value = message
}

async function checkNow() {
  if (!host.value || checking.value) return
  checking.value = true
  checkMessage.value = ''
  try {
    const res = await $fetch<{ requestId: string }>(`/api/hosts/${host.value}/check`, { method: 'POST' })
    pendingRequestId = res.requestId
    checkTimer = setTimeout(() => finishCheck('No reply from the machine. It may be offline.'), CHECK_TIMEOUT_MS)
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode
    finishCheck(code === 429 ? 'Please wait a moment before checking again.' : code === 503 ? 'The MQTT broker is not connected.' : 'Could not send the check request.')
  }
}

function touchHostLocally(id: string, online: boolean) {
  const h = hostsData.value?.hosts.find(x => x.hostId === id)
  if (!h) { void refreshHosts(); return }
  h.lastSeen = new Date().toISOString()
  h.online = online
}

function onMessage(raw: MessageEvent) {
  let msg: BusMessage
  try { msg = JSON.parse(raw.data) } catch { return }
  if (msg.type === 'ping') return
  if (msg.type === 'broker') { brokerConnected.value = msg.connected; return }
  if (msg.type === 'status') { void refreshHosts(); return }
  touchHostLocally(msg.host, true)
  if (!host.value) host.value = msg.host
  if (msg.host !== host.value) return
  if (msg.type === 'reading') {
    current.value = msg.reading
    live.value = appendLive(live.value, msg.reading, MAX_LIVE_POINTS)
    if (msg.stored) void refreshHistory()
    if (msg.requestId && msg.requestId === pendingRequestId) finishCheck()
  } else {
    events.value = [msg.event, ...(events.value ?? [])].slice(0, MAX_EVENTS)
  }
}

onMounted(() => {
  let opened = false
  source = new EventSource('/api/stream')
  source.onmessage = onMessage
  source.onopen = () => {
    streamUp.value = true
    // After a reconnect, re-sync everything that may have changed while the stream was down.
    if (opened) void Promise.all([refreshHosts(), refreshCurrent(), refreshHistory(), refreshEvents()])
    opened = true
  }
  source.onerror = () => { streamUp.value = false }
  clockTimer = setInterval(() => { now.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => { source?.close(); clearInterval(clockTimer); clearTimeout(checkTimer) })

const gb = formatBytes
const pct = (u: number, t: number) => (t ? (u / t) * 100 : 0)
const points = computed(() => withLive(history.value ?? [], live.value))
const cpuPoints = computed(() => points.value.map(p => ({ ts: p.ts, value: p.cpuPercent })))
const memPoints = computed(() => points.value.map(p => ({ ts: p.ts, value: pct(p.memUsed, p.memTotal) })))
const chartMount = computed(() => current.value?.disks[0]?.mount)
const diskPoints = computed(() => diskSeries(points.value, chartMount.value))
const when = (ts: string) => new Date(ts).toLocaleString()
</script>

<template>
  <main class="mx-auto max-w-4xl space-y-6 p-4">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-bold">Computer usage</h1>
      <div class="flex items-center gap-2">
        <select v-if="hostsData?.hosts.length" v-model="host" class="rounded border border-slate-300 bg-white px-2 py-1 text-sm" aria-label="Machine">
          <option v-for="h in hostsData.hosts" :key="h.hostId" :value="h.hostId">{{ h.hostId }}</option>
        </select>
        <span v-if="hostStatus" class="text-sm" :class="hostStatus === 'online' ? 'text-emerald-700' : 'text-amber-700'">{{ hostStatus }}</span>
        <button class="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-50" :disabled="!host || checking || !brokerConnected" @click="checkNow">
          {{ checking ? 'Checking…' : 'Check now' }}
        </button>
      </div>
    </header>

    <p v-if="!brokerConnected" class="rounded bg-amber-50 p-3 text-amber-800">MQTT disconnected: no new data is arriving until the broker is back.</p>
    <p v-if="!streamUp" class="rounded bg-amber-50 p-3 text-amber-800">Live updates are disconnected, retrying…</p>
    <p v-if="checkMessage" class="rounded bg-slate-100 p-3 text-slate-700" role="status">{{ checkMessage }}</p>
    <div v-if="alerts.length" class="space-y-1 rounded border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
      <p v-for="a in alerts" :key="a.kind + (a.mount ?? '')" class="font-medium">{{ describeAlert(a) }}</p>
    </div>

    <p v-if="currentError" class="rounded bg-red-50 p-3 text-red-700">Could not read system metrics.</p>
    <p v-else-if="!host" class="rounded border border-slate-200 bg-white p-4 text-slate-600">
      No machines have reported yet. Start an agent (see the manual); the first reading appears within a few minutes.
    </p>
    <p v-else-if="!current" class="rounded border border-slate-200 bg-white p-4 text-slate-600">
      Waiting for the first reading from {{ host }}. Readings arrive every few minutes, or click Check now.
    </p>
    <section v-else class="space-y-3 rounded border border-slate-200 bg-white p-4">
      <p class="text-xs text-slate-500">Last reading: {{ when(current.ts) }}</p>
      <GaugeBar label="CPU" :percent="current.cpuPercent" />
      <GaugeBar label="Memory" :percent="pct(current.memUsed, current.memTotal)" :detail="`${gb(current.memUsed)} / ${gb(current.memTotal)}`" />
      <GaugeBar v-for="d in current.disks" :key="d.mount" :label="`Disk ${d.mount}`" :percent="pct(d.used, d.total)" :detail="`${gb(d.used)} / ${gb(d.total)}`" />
    </section>

    <section v-if="host" class="space-y-3">
      <div class="flex gap-2">
        <button v-for="r in (['1h', '24h', '7d'] as const)" :key="r" class="rounded px-3 py-1 text-sm" :class="range === r ? 'bg-sky-600 text-white' : 'bg-slate-200'" @click="range = r">{{ r }}</button>
      </div>
      <UsageChart title="CPU" :points="cpuPoints" />
      <UsageChart title="Memory" :points="memPoints" :total="current?.memTotal" />
      <UsageChart :title="`Disk (${chartMount ?? 'first disk'})`" :points="diskPoints" :total="current?.disks[0]?.total" />
    </section>

    <section v-if="events?.length" class="rounded border border-slate-200 bg-white p-3">
      <h2 class="mb-2 text-sm font-semibold">Recent events</h2>
      <ul class="space-y-1 text-sm">
        <li v-for="e in events" :key="e.ts + e.kind + e.state + (e.mount ?? '')" class="flex justify-between gap-3">
          <span :class="e.state === 'alert' ? 'text-red-700' : 'text-emerald-700'">{{ e.state === 'alert' ? 'Alert' : 'Recovered' }}: {{ describeAlert(e) }}</span>
          <span class="shrink-0 text-slate-500">{{ when(e.ts) }}</span>
        </li>
      </ul>
    </section>
  </main>
</template>
```

- [ ] **Step 3: Build** — `npx nuxt build 2>&1 | grep -iE "error|cannot|unresolved"` (ignore `error-404/500` asset names) → none.

- [ ] **Step 4: Run the whole app and the agent together (needs Docker for Postgres and Mosquitto)**

```bash
cd /media/luis/data-luis/TYI/web/computer-usage
docker compose up -d && cp -n .env.example .env
npm run dev &                                   # app on http://localhost:3000
cd ../lib/computer-usage-agent && cp -n .env.example .env && npm start   # agent for host "local"
```
Check, and report what you actually saw: (1) app log `connected to MQTT broker`; (2) agent log `connected to broker`; (3) within seconds the dashboard shows host `local` with gauges and charts (the first heartbeat is published at start); (4) **Check now** shows "Checking…" then returns within a second or two and the "Last reading" time changes; (5) set `MEMORY_THRESHOLD_PERCENT=1` in the agent `.env` and restart it: a red alert banner and an "Alert" row appear within about 20 s (a restart resets the agent's threshold state, so recovery is not observable this way; recovery is covered by the threshold tests); (6) stop the agent (Ctrl-C): the host shows "offline"; (7) `docker stop computer-usage-mqtt`: the amber "MQTT disconnected" banner appears and Check now is disabled. If Docker or a browser is unavailable, state which of these were not verified.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: multi-host dashboard with live stream, alerts and Check now

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Stage 4 — Documentation

### Task 14: ADRs, diagrams, user guides, pending tasks

**Files:**
- Create: `web/docs/architecture/adrs/0008-computer-usage-mqtt-transport.md`, `web/docs/architecture/adrs/0009-computer-usage-agent-shared-package.md`
- Modify: `web/docs/architecture/{business,application,data,technology}-architecture.md` (the `## computer-usage` section of each); `computer-usage/docs/user-guides/{config,manual,features}.md`, `computer-usage/docs/pending-tasks.md`, `computer-usage/README.md`, `web/CLAUDE.md` (table row for `lib/` mention of `computer-usage-agent`, only if the table lists lib packages: check first)

- [ ] **Step 1: ADR 0008** — create `web/docs/architecture/adrs/0008-computer-usage-mqtt-transport.md`:

```markdown
# ADR 0008: computer-usage collects metrics from many machines over MQTT

Date: 2026-10-06
Status: Accepted (supersedes the in-process sampler of ADR 0006)

## Context

computer-usage sampled only the machine running the app, once a minute, and stored every sample. Monitoring several machines that way would grow the database quickly and tell the dashboard nothing until the next poll.

## Decision

1. Every machine, including the one running the app, runs an agent (`lib/computer-usage-agent`) that publishes to an MQTT broker (Mosquitto).
2. Agents send a heartbeat reading every 5 minutes and an event when CPU, memory or a disk crosses its threshold (and when it recovers). Thresholds are evaluated on the agent from env vars.
3. The app subscribes in a Nitro plugin (QoS 1, persistent session), stores heartbeats and events in Postgres tagged by `host_id`, and pushes updates to browsers over Server-Sent Events.
4. "Check now" publishes a request to the host's `check` topic; the reply is forwarded to browsers but not stored.
5. Trusted-network security: username/password per agent and a Mosquitto ACL restricting each agent to `computer-usage/<its host>/`. TLS is future work.

## Alternatives considered

- **HTTP push to the app / direct database writes / app pulls from each machine:** simpler to start, but either expose the database, require every machine to be reachable, or give no event-driven updates.
- **Separate ingest service:** survives app restarts better, but a second deployable; QoS 1 persistent sessions already cover short app outages.
- **Browsers subscribing to the broker over WebSockets:** exposes the broker to browsers and moves validation into the client.

## Consequences

The in-process sampler and its pending task (sampling stops while the app is down) are gone; the agent keeps sampling independently. The database grows about 5x slower per machine than before. Readings sent to the broker while the app is down are held by the broker (up to 5000 messages per session). Threshold changes require editing each agent's config until central configuration is built.
```

- [ ] **Step 2: ADR 0009** — create `web/docs/architecture/adrs/0009-computer-usage-agent-shared-package.md`:

```markdown
# ADR 0009: the computer-usage agent and wire protocol live in a shared lib package

Date: 2026-10-06
Status: Accepted

## Context

Both the agent (on every machine) and the app (which receives its messages) need the same topic names and payload validation. The repo convention is that code shared by two projects goes in `lib/` instead of being copied.

## Decision

`lib/computer-usage-agent/` is a standalone TypeScript package with its own tests. It contains the collector, threshold state machine, MQTT runtime, CLI and `src/protocol.ts`. The protocol file has no dependencies and is exported as `computer-usage-agent/protocol`, which the Nuxt app imports through a `file:` dependency. The app inlines the package in Nitro (`nitro.externals.inline`) because it ships TypeScript source.

## Consequences

One definition of the wire format. Agents are installed from this folder on each machine (`npm install && npm start`); there is no published package yet.
```

- [ ] **Step 3: Replace the `## computer-usage` section in each architecture file** (the block from `## computer-usage` to the end of its plantuml fence; the data file's section also currently holds the retention note, keep it)

`business-architecture.md`:
````markdown
## computer-usage

```plantuml
@startuml
actor Operator
rectangle "computer-usage" as cu {
  rectangle "Machine reporting (heartbeat + threshold events)" as reporting
  rectangle "Usage dashboard, history & alerts" as dash
}
Operator --> dash : checks usage of every machine, clicks Check now
reporting --> dash : readings and alerts
@enduml
```
````

`application-architecture.md`:
````markdown
## computer-usage

```plantuml
@startuml
package "computer-usage-agent (one per machine)" {
  [Collector\n(systeminformation)] as coll
  [Threshold state machine] as thr
  [MQTT agent runtime\n(heartbeat, events, check replies)] as agent
}
package "computer-usage (Nuxt 4)" {
  [MQTT plugin + ingest\n(validate, retry)] as ingest
  [Event bus] as bus
  [GET /api/stream (SSE)] as sse
  [POST /api/hosts/:host/check] as check
  [GET /api/hosts, /api/events,\n/api/metrics/*] as api
  [Dashboard page\n(host picker, alerts, Check now)] as ui
  [Retention plugin] as ret
  [Repository (Drizzle)] as repo
}
queue "Mosquitto broker\n(ACL per host)" as mqtt
database "Postgres 18\n(computer-usage)" as db
coll --> thr
coll --> agent
thr --> agent
agent --> mqtt : heartbeat, event, reading, status
mqtt --> agent : check
mqtt --> ingest : QoS 1
ingest --> repo
ingest --> bus
bus --> sse
check --> mqtt : check
ui --> sse
ui --> api
ui --> check
api --> repo
ret --> repo
repo --> db
@enduml
```
````

`data-architecture.md` (keep the retention note, add events/hosts, `host_id`):
````markdown
## computer-usage

```plantuml
@startuml
entity samples {
  * id : serial <<PK>>
  --
  * host_id : text (default 'local')
  * ts : timestamptz (unique with host_id)
  * cpu_percent : real
  * mem_used : bigint (bytes)
  * mem_total : bigint (bytes)
}
entity disk_samples {
  * id : serial <<PK>>
  --
  * sample_id : integer <<FK>> (on delete cascade)
  * mount : text
  * used : bigint (bytes)
  * total : bigint (bytes)
}
entity events {
  * id : serial <<PK>>
  --
  * host_id : text
  * ts : timestamptz
  * kind : cpu | memory | disk
  * state : alert | ok
  * value : real
  * threshold : real
  * mount : text ('' for cpu/memory)
}
entity hosts {
  * host_id : text <<PK>>
  --
  * online : boolean
  * last_seen : timestamptz
}
samples ||--o{ disk_samples
note right of samples
  Database "computer-usage" (Postgres 18)
  one row per host per heartbeat (default 5 min)
  samples and events pruned after RETENTION_DAYS (default 30)
end note
@enduml
```
````

`technology-architecture.md`:
````markdown
## computer-usage

```plantuml
@startuml
node "Every monitored machine" {
  component "computer-usage-agent\n(Node + TypeScript + mqtt + systeminformation)" as agent
}
node "Central machine (npm run dev)" {
  component "Nuxt 4 / Nitro + Vue 3 + Tailwind\n(mqtt client, SSE)" as app
}
node "Docker" {
  queue "Mosquitto 2 :1883\n(password file + ACL)" as mqtt
  database "Postgres 18 :5433\n(computer-usage, computer-usage-test)" as pg
}
agent --> mqtt : MQTT QoS 1 (trusted network)
mqtt --> app : MQTT QoS 1, persistent session
app --> pg : pg + Drizzle ORM
@enduml
```
````

- [ ] **Step 4: Update `docs/user-guides/config.md`** — replace the variable table and add the broker section:

```markdown
# Configuration

Copy `.env.example` to `.env` and adjust if needed. Nuxt loads `.env` automatically in `npm run dev`.

## App

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage` | Postgres connection string for the app. |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage-test` | Database used by `npm test`. Never point it at real data: the repository tests truncate `samples`, `events` and `hosts`. |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker the app subscribes to. |
| `MQTT_USERNAME` | `app` | Broker user for the app (must have the `app` ACL rules). |
| `MQTT_PASSWORD` | none | Password for that user. |
| `HEARTBEAT_INTERVAL_MS` | `300000` | Must match the agents' heartbeat interval; a host with no message for twice this long is shown as having no recent data. |
| `RETENTION_DAYS` | `30` | Samples and events older than this many days are deleted (daily, and once at startup). `0` disables pruning. Invalid values fall back to 30. |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables tracing logs (messages ingested, saved samples, stream connections). Errors are always logged. |

## Agent (one per machine)

See `lib/computer-usage-agent/README.md` for the full table: `HOST_ID`, `MQTT_URL`, `MQTT_USERNAME` (must equal `HOST_ID`), `MQTT_PASSWORD`, `HEARTBEAT_INTERVAL_MS`, `CHECK_INTERVAL_MS`, `CPU_THRESHOLD_PERCENT`, `CPU_CONSECUTIVE_CHECKS`, `MEMORY_THRESHOLD_PERCENT`, `DISK_THRESHOLD_PERCENT`, `QUEUE_LIMIT`.

## Docker (Postgres and Mosquitto)

```bash
docker/mosquitto/add-user.sh app <password>        # the app's broker user
docker/mosquitto/add-user.sh <HOST_ID> <password>  # one per machine; username must equal the agent's HOST_ID
docker compose up -d                               # or: npm run db:up
```

- Postgres: image `postgres:18`, container `computer-usage-db`, host port **5433**. Databases `computer-usage` (app) and `computer-usage-test` (tests) are created on the first start. The init script runs only when the volume is first created; if `computer-usage-test` is missing, run `docker compose down -v && docker compose up -d` (this deletes stored samples).
- Mosquitto: image `eclipse-mosquitto:2`, container `computer-usage-mqtt`, port **1883**, authentication required. Users live in `docker/mosquitto/passwd` (not committed); `docker/mosquitto/acl` limits each agent to `computer-usage/<its HOST_ID>/`. After adding a user, `docker compose restart mosquitto`. The broker is meant for a trusted network (LAN/VPN): it has no TLS yet.
- Tables are created automatically by migrations when the server boots. After changing `server/db/schema.ts`, run `npm run db:generate` and commit the new SQL in `drizzle/`.
```

- [ ] **Step 5: Update `docs/user-guides/manual.md`** — replace the whole file with:

````markdown
# User manual

## Getting started

1. Create broker users: `docker/mosquitto/add-user.sh app <password>` and `docker/mosquitto/add-user.sh local <password>` (use one user per machine; the username is the machine's `HOST_ID`).
2. Start Postgres and the broker: `docker compose up -d`.
3. Create the app env file: `cp .env.example .env` and set `MQTT_PASSWORD` to the `app` password.
4. Start the app: `npm run dev`. The log shows `connected to MQTT broker`.
5. On every machine you want to monitor (including this one), start an agent:

   ```bash
   cd lib/computer-usage-agent
   cp .env.example .env     # set HOST_ID, MQTT_URL (the broker's address) and MQTT_PASSWORD
   npm install && npm start
   ```

   From this repo you can also run `npm run agent`. The agent log shows `connected to broker`.
6. Open http://localhost:3000. The first reading appears as soon as the agent connects.

## Reading the dashboard

1. Use the machine picker to choose a host. The label next to it shows `online`, `offline` (the agent stopped or lost its connection) or `no recent data` (nothing received for twice the heartbeat interval).
2. The top panel shows the host's latest CPU, memory and one gauge per disk. Colours turn amber at 70% and red at 90%.
3. Use the **1h / 24h / 7d** buttons to change the history charts. Each chart has 0/50/100% gridlines (with real sizes for memory and disk) and shows the current reading in its title.
4. Data updates when a heartbeat arrives (every 5 minutes by default), when an alert or recovery event happens, and when you click **Check now**. There is no polling: the page receives updates as they happen.
5. **Check now** asks the selected machine for a fresh reading. It appears within a second or two. Check-now readings are shown but not stored, so the charts keep the 5-minute stored points plus the readings received since the page was opened. If the machine does not answer within 10 seconds you will see "No reply from the machine"; clicking again within 2 seconds shows "Please wait a moment".
6. A red banner lists alerts that are still open (CPU, memory or a disk crossing its threshold). It clears when the agent reports recovery. **Recent events** lists the latest alerts and recoveries.
7. Amber banners mean the app lost the MQTT broker, or the browser lost its live connection (it reconnects by itself and re-syncs).

## Querying the stored data

```bash
docker exec computer-usage-db psql -U postgres -d computer-usage \
  -c "select host_id, ts, cpu_percent, mem_used, mem_total from samples order by ts desc limit 10"
docker exec computer-usage-db psql -U postgres -d computer-usage \
  -c "select host_id, ts, kind, state, value, threshold, mount from events order by ts desc limit 10"
```

Sizes are bytes; `cpu_percent` is 0–100.

## Troubleshooting

- **A machine does not appear**: check the agent log. `connected to broker` means it reached Mosquitto; a connection error with "not authorized" means the user/password is wrong or the username is not the `HOST_ID`. Check the app log for `mqtt message rejected` (invalid or hostile payloads) or `ingest failed`.
- **The app shows "MQTT disconnected"**: the broker is down or `MQTT_URL`/credentials are wrong; the log shows `mqtt error`.
- **Alerts never fire**: lower the agent's thresholds to test (e.g. `MEMORY_THRESHOLD_PERCENT=1`), restart it and wait up to `CHECK_INTERVAL_MS`. CPU alerts need `CPU_CONSECUTIVE_CHECKS` checks in a row.
- **More detail**: set `NUXT_ADD_DEBUG_LOGS=true` (app and agent) and restart.

## Sequence diagrams

Heartbeat and threshold event:

```mermaid
sequenceDiagram
  participant A as Agent
  participant M as Mosquitto
  participant S as App (MQTT plugin)
  participant DB as Postgres
  participant B as Browser (SSE)
  loop every 5 min
    A->>M: heartbeat reading (QoS 1)
    M->>S: heartbeat
    S->>DB: insert sample (ignored if duplicate)
    S-->>B: reading (charts and gauges update)
  end
  loop every 20 s
    A->>A: check thresholds
  end
  A->>M: event (alert or ok) when state changes
  M->>S: event
  S->>DB: insert event
  S-->>B: event (banner and list update)
```

Check now:

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as App
  participant M as Mosquitto
  participant A as Agent
  B->>S: POST /api/hosts/web-01/check
  S->>M: check {requestId}
  M->>A: check
  A->>M: reading {requestId, ...}
  M->>S: reading
  S-->>B: reading over SSE (not stored)
  Note over B: no reply within 10 s shows "No reply from the machine"
```
````

- [ ] **Step 6: Update `docs/user-guides/features.md`** — replace the whole file with:

```markdown
# Features

- **Many machines, one dashboard** — an agent on each machine reports CPU %, memory used/total and every real disk's used/total over MQTT; a machine picker switches between them.
- **Heartbeat plus events** — each agent sends a reading every 5 minutes (stored in Postgres, tagged by host) and an immediate event when CPU, memory or a disk crosses its threshold, and again when it recovers.
- **Alerts** — thresholds are set on each agent (defaults: CPU 90% for 3 consecutive checks, memory 90%, each disk 90%). Open alerts show as a red banner; recent alerts and recoveries are listed.
- **Check now** — fetches a fresh reading from the selected machine on demand (not stored).
- **Live updates without polling** — the dashboard receives readings and events over Server-Sent Events, and reconnects and re-syncs by itself.
- **Machine status** — online, offline (agent stopped) or no recent data; banners show when the MQTT broker or the live connection is down.
- **Multi-disk support** — one row per mount point; duplicate devices, snap/loop mounts and kernel pseudo-filesystems (`/sys`, `/proc`, `/run`, `/dev`) are ignored.
- **Live gauges** — colour-coded (green < 70%, amber ≥ 70%, red ≥ 90%).
- **History charts** — CPU, memory and first-disk usage over the last 1 hour, 24 hours or 7 days, with 0/50/100% gridlines (real sizes for memory and disk) and the current reading in the title.
- **Data retention** — samples and events older than `RETENTION_DAYS` (default 30) are deleted once at startup and then daily. Set `0` to keep everything.
- **Resilient transport** — QoS 1 with persistent sessions, a bounded offline queue on each agent, duplicate deliveries ignored, invalid messages logged and dropped.
- **Per-agent broker access** — each agent has its own broker user and can only publish under its own host topic.
- **Automatic schema migrations** on server start.
- **Diagnostics** — structured error logs with context; optional tracing via `NUXT_ADD_DEBUG_LOGS`.
- **JSON API** — `GET /api/hosts`, `GET /api/metrics/current?host=`, `GET /api/metrics/history?range=1h|24h|7d&host=`, `GET /api/events?host=`, `POST /api/hosts/:host/check`, `GET /api/stream` (SSE).
```

- [ ] **Step 7: Update `docs/pending-tasks.md`** — remove tasks 4 (multiple machines), 5 (alerting) and 7 (sampling stops while the app is down) and renumber; in task 8 delete item (e) (the current endpoint now reads the database, so there is no CPU-window problem) and reword (c)/(d) to refer to the agent's `heartbeat`/`threshold check`; then append these new tasks, each with description, value and consequence:

```markdown
## Central threshold configuration
- **Description:** Edit alert thresholds (per host or fleet-wide) from the dashboard or app config and push them to agents over MQTT, with safe defaults on the agent if the app is down.
- **Value:** Tune alerting for the whole fleet in one place.
- **Consequence of not doing it:** Changing a threshold means editing that machine's agent config and restarting it.

## TLS for the MQTT broker
- **Description:** Enable TLS on Mosquitto with certificates and make agents and the app verify it.
- **Value:** Safe use over untrusted networks and the internet.
- **Consequence of not doing it:** Credentials and readings travel unencrypted, so the broker must stay on a trusted LAN/VPN.

## Viewer-driven fast live mode
- **Description:** While a browser has a host open, have the app send `check` requests every few seconds so charts move faster than the 5-minute heartbeat; stop when the last viewer leaves.
- **Value:** Near-real-time charts when someone is watching.
- **Consequence of not doing it:** Between heartbeats the dashboard only changes on events or when Check now is clicked.
```

- [ ] **Step 8: Update `README.md`** — replace the quick start block with:

```markdown
## Quick start

```bash
docker/mosquitto/add-user.sh app <password>       # broker user for the app
docker/mosquitto/add-user.sh local <password>     # broker user for this machine's agent (username = HOST_ID)
docker compose up -d        # Postgres 18 on localhost:5433, Mosquitto on localhost:1883
cp .env.example .env        # set MQTT_PASSWORD
npm install
npm run dev                 # http://localhost:3000
# in another terminal, start the agent for this machine:
cd ../lib/computer-usage-agent && cp .env.example .env && npm install && npm start
npm test
```
```
and change the first sentence to: `System resources monitor: agents on one or more machines report CPU, memory and disk usage over MQTT (heartbeat every 5 minutes plus threshold alerts), stored in Postgres (database `computer-usage`) and shown on a dashboard.`

- [ ] **Step 9: Check `web/CLAUDE.md`** — run `grep -n "computer-usage" ../CLAUDE.md`; if the project table lists `lib/` packages or each project, add a row/mention for `computer-usage` and `lib/computer-usage-agent`; if it lists neither, leave it alone.

- [ ] **Step 10: Commit** (docs live in two repos: the app's docs in `computer-usage`; `web/docs/architecture` is outside both git repos unless `web/` is one, so check `git -C .. status` and commit only where a repo exists)

```bash
git add -A && git commit -m "docs: document MQTT multi-host monitoring, ADRs 0008-0009 and diagrams

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Final verification

- [ ] **Step 1: Agent package** — `cd /media/luis/data-luis/TYI/web/lib/computer-usage-agent && npx vitest run && npx tsc --noEmit` → all PASS, no type errors.
- [ ] **Step 2: App unit tests (no Docker)** — `cd ../../computer-usage && npx vitest run tests/ingest.test.ts tests/retry.test.ts tests/check.test.ts tests/host.test.ts tests/alerts.test.ts tests/ready.test.ts tests/mqtt-config.test.ts tests/retention.test.ts tests/series.test.ts tests/range.test.ts tests/log.test.ts` → PASS.
- [ ] **Step 3: App DB tests (needs Docker)** — `docker compose up -d && npm test` → everything PASSES, including `tests/repository.test.ts` and `tests/db.test.ts`. If Docker is unavailable, report these as not run.
- [ ] **Step 4: Leftovers** — `grep -rn "SAMPLE_INTERVAL_MS\|collectMetrics\|createTick\|sampler" server app tests docs ../docs/architecture README.md .env.example` should find nothing except historical mentions in ADR 0006, the old spec/plan files, and learnings. Fix the rest. Remove `systeminformation` from the app with `npm uninstall systeminformation` if nothing imports it.
- [ ] **Step 5: Build and end-to-end** — `npx nuxt build` has no errors, and repeat the manual run from Task 13 Step 4 (report what was and was not observed).
- [ ] **Step 6: Report** — summarize results honestly, including every verification that could not run (Docker, browser), and that `git status` shows nothing unintended.
