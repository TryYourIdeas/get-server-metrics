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
