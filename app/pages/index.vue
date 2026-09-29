<script setup lang="ts">
type Disk = { mount: string; used: number; total: number }
type Current = { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: Disk[] }
type Point = { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: Disk[] }

const range = ref<'1h' | '24h' | '7d'>('1h')
const { data: current, error: currentError, refresh: refreshCurrent } = await useFetch<Current>('/api/metrics/current')
const { data: history, refresh: refreshHistory } = await useFetch<Point[]>('/api/metrics/history', { query: { range } })

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { refreshCurrent(); refreshHistory() }, 60_000) })
onBeforeUnmount(() => clearInterval(timer))

const gb = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB'
const pct = (u: number, t: number) => (t ? (u / t) * 100 : 0)
const cpuPoints = computed(() => (history.value ?? []).map(p => ({ ts: p.ts, value: p.cpuPercent })))
const memPoints = computed(() => (history.value ?? []).map(p => ({ ts: p.ts, value: pct(p.memUsed, p.memTotal) })))
const chartMount = computed(() => current.value?.disks[0]?.mount)
const diskPoints = computed(() => diskSeries(history.value ?? [], chartMount.value))
</script>

<template>
  <main class="mx-auto max-w-4xl space-y-6 p-4">
    <h1 class="text-2xl font-bold">Computer usage</h1>
    <p v-if="currentError" class="rounded bg-red-50 p-3 text-red-700">Could not read system metrics.</p>
    <section v-else-if="current" class="space-y-3 rounded border border-slate-200 bg-white p-4">
      <GaugeBar label="CPU" :percent="current.cpuPercent" />
      <GaugeBar label="Memory" :percent="pct(current.memUsed, current.memTotal)" :detail="`${gb(current.memUsed)} / ${gb(current.memTotal)}`" />
      <GaugeBar v-for="d in current.disks" :key="d.mount" :label="`Disk ${d.mount}`" :percent="pct(d.used, d.total)" :detail="`${gb(d.used)} / ${gb(d.total)}`" />
    </section>

    <section class="space-y-3">
      <div class="flex gap-2">
        <button v-for="r in (['1h', '24h', '7d'] as const)" :key="r" class="rounded px-3 py-1 text-sm" :class="range === r ? 'bg-sky-600 text-white' : 'bg-slate-200'" @click="range = r">{{ r }}</button>
      </div>
      <UsageChart title="CPU %" :points="cpuPoints" />
      <UsageChart title="Memory %" :points="memPoints" />
      <UsageChart :title="`Disk % (${chartMount ?? 'first disk'})`" :points="diskPoints" />
    </section>
  </main>
</template>
