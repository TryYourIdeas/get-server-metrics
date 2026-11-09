<script setup lang="ts">
import type { Reading, UsageEvent } from 'agent/protocol'
import type { OverviewEntry } from '../../../shared/server/utils/repository'
import type { BusMessage } from '~/utils/overview'

type HostInfo = { hostId: string; online: boolean; lastSeen: string }
type HostsResponse = { hosts: HostInfo[]; brokerConnected: boolean; staleAfterMs: number }

/** The machine selector value that shows every machine at once. */
const ALL = '__all__'

const MAX_LIVE_POINTS = 720
const CHECK_TIMEOUT_MS = 10_000
const MAX_EVENTS = 50

const range = ref<'1h' | '24h' | '7d'>('1h')
const { data: hostsData, refresh: refreshHosts } = await useFetch<HostsResponse>('/api/hosts')
const view = ref<string>(ALL)
/** The machine shown in the detail view; undefined while "All servers" is selected. */
const host = computed(() => (view.value === ALL ? undefined : view.value))
// The detail data is only fetched for a real machine, so nothing is requested while "All servers" is shown.
const detailFetch = { watch: false, immediate: !!host.value } as const
const { data: current, error: currentError, refresh: refreshCurrent } = await useFetch<Reading | null>('/api/metrics/current', { query: { host }, ...detailFetch })
const { data: history, refresh: refreshHistory } = await useFetch<Reading[]>('/api/metrics/history', { query: { range, host }, ...detailFetch })
const { data: events, refresh: refreshEvents } = await useFetch<UsageEvent[]>('/api/events', { query: { host }, ...detailFetch })
const { data: overviewData, refresh: refreshOverview } = await useFetch<{ entries: OverviewEntry[] }>('/api/overview')
const overview = ref<OverviewEntry[]>(overviewData.value?.entries ?? [])
watch(overviewData, (v) => { overview.value = v?.entries ?? [] })

// Points received over the stream, merged after the stored history so charts move between database re-syncs.
const live = ref<Reading[]>([])
watch([range, host], () => { live.value = [] })
watch(host, (h) => { if (h) void Promise.all([refreshCurrent(), refreshHistory(), refreshEvents()]) })
watch(range, () => { if (host.value) void refreshHistory() })

const brokerConnected = ref(hostsData.value?.brokerConnected ?? false)
const streamUp = ref(true)
const now = ref(Date.now())

const checking = ref(false)
const checkMessage = ref('')
const deletingLogs = ref(false)
const logsMessage = ref('')
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
const sortedOverview = computed(() => sortEntries(overview.value, now.value, hostsData.value?.staleAfterMs ?? 600_000))

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

async function deleteHostLogs() {
  if (!host.value || deletingLogs.value) return
  const hostToDelete = host.value
  if (!window.confirm(`Delete all stored samples and events for "${hostToDelete}"? This cannot be undone.`)) return

  deletingLogs.value = true
  logsMessage.value = ''
  try {
    const deleted = await $fetch<{ samples: number; events: number }>(`/api/hosts/${encodeURIComponent(hostToDelete)}/logs`, { method: 'DELETE' })
    live.value = []
    await Promise.all([refreshCurrent(), refreshHistory(), refreshEvents()])
    logsMessage.value = `Deleted ${deleted.samples} samples and ${deleted.events} events for ${hostToDelete}. The machine entry was kept.`
  } catch {
    logsMessage.value = `Could not delete stored data for ${hostToDelete}.`
  } finally {
    deletingLogs.value = false
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
  const nextOverview = applyStreamMessage(overview.value, msg, new Date().toISOString())
  if (nextOverview !== overview.value) overview.value = nextOverview
  else void refreshOverview() // a machine the overview does not know yet
  if (msg.type === 'status') { void refreshHosts(); return }
  touchHostLocally(msg.host, true)
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
    if (opened) {
      void Promise.all([refreshHosts(), refreshOverview(), ...(host.value ? [refreshCurrent(), refreshHistory(), refreshEvents()] : [])])
    }
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
        <select v-if="hostsData?.hosts.length" v-model="view" class="rounded border border-slate-300 bg-white px-2 py-1 text-sm" aria-label="Machine">
          <option :value="ALL">All servers</option>
          <option v-for="h in hostsData.hosts" :key="h.hostId" :value="h.hostId">{{ h.hostId }}</option>
        </select>
        <span v-if="hostStatus" class="text-sm" :class="hostStatus === 'online' ? 'text-emerald-700' : 'text-amber-700'">{{ hostStatus }}</span>
        <NuxtLink to="/triggers" class="rounded border border-slate-300 bg-white px-3 py-1 text-sm">Triggers</NuxtLink>
        <button class="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-50" :disabled="!host || checking || !brokerConnected" @click="checkNow">
          {{ checking ? 'Checking…' : 'Check now' }}
        </button>
        <button class="rounded bg-red-700 px-3 py-1 text-sm text-white disabled:opacity-50" :disabled="!host || deletingLogs" @click="deleteHostLogs">
          {{ deletingLogs ? 'Deleting…' : 'Delete server logs' }}
        </button>
      </div>
    </header>

    <p v-if="!brokerConnected" class="rounded bg-amber-50 p-3 text-amber-800">MQTT disconnected: no new data is arriving until the broker is back.</p>
    <p v-if="!streamUp" class="rounded bg-amber-50 p-3 text-amber-800">Live updates are disconnected, retrying…</p>
    <p v-if="checkMessage" class="rounded bg-slate-100 p-3 text-slate-700" role="status">{{ checkMessage }}</p>
    <p v-if="logsMessage" class="rounded bg-slate-100 p-3 text-slate-700" role="status">{{ logsMessage }}</p>
    <div v-if="alerts.length" class="space-y-1 rounded border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
      <p v-for="a in alerts" :key="a.kind + (a.mount ?? '')" class="font-medium">{{ describeAlert(a) }}</p>
    </div>

    <template v-if="view === ALL">
      <p v-if="!overview.length" class="rounded border border-slate-200 bg-white p-4 text-slate-600">
        No machines have reported yet. Start an agent (see the manual); the first reading appears within a few minutes.
      </p>
      <section v-else class="grid gap-4 sm:grid-cols-2" aria-label="All servers">
        <ServerCard
          v-for="e in sortedOverview"
          :key="e.hostId"
          :entry="e"
          :state="cardState(e, now, hostsData?.staleAfterMs ?? 600_000)"
          @select="view = $event"
        />
      </section>
    </template>

    <template v-else>
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
    </template>
  </main>
</template>
