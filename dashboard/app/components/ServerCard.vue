<script setup lang="ts">
import type { OverviewEntry } from '../../../shared/server/utils/repository'
import type { CardState } from '~/utils/overview'

const props = defineProps<{ entry: OverviewEntry; state: CardState }>()
const emit = defineEmits<{ select: [hostId: string] }>()

const labels: Record<CardState, string> = { alert: 'Alert', offline: 'Offline', stale: 'No recent data', waiting: 'Waiting for data', ok: 'Online' }
const badge: Record<CardState, string> = {
  alert: 'bg-red-100 text-red-800', offline: 'bg-slate-200 text-slate-700', stale: 'bg-amber-100 text-amber-800',
  waiting: 'bg-slate-100 text-slate-600', ok: 'bg-emerald-100 text-emerald-800'
}
const pct = (u: number, t: number) => (t ? (u / t) * 100 : 0)
const alerts = computed(() => activeAlerts(props.entry.events))
const dim = computed(() => props.state === 'offline' || props.state === 'stale')
</script>

<template>
  <button
    type="button"
    class="block w-full space-y-3 rounded border bg-white p-4 text-left shadow-sm hover:border-sky-400"
    :class="[state === 'alert' ? 'border-red-300' : 'border-slate-200', dim ? 'opacity-70' : '']"
    :aria-label="`Open ${entry.hostId}`"
    @click="emit('select', entry.hostId)"
  >
    <div class="flex items-center justify-between gap-2">
      <h2 class="truncate font-semibold">{{ entry.hostId }}</h2>
      <span class="shrink-0 rounded px-2 py-0.5 text-xs" :class="badge[state]">{{ labels[state] }}</span>
    </div>
    <template v-if="entry.current">
      <GaugeBar label="CPU" :percent="entry.current.cpuPercent" />
      <GaugeBar label="Memory" :percent="pct(entry.current.memUsed, entry.current.memTotal)" />
      <GaugeBar v-for="d in entry.current.disks" :key="d.mount" :label="`Disk ${d.mount}`" :percent="pct(d.used, d.total)" />
    </template>
    <p v-else class="text-sm text-slate-500">Waiting for the first reading.</p>
    <ul v-if="alerts.length" class="space-y-0.5 text-sm text-red-700">
      <li v-for="a in alerts" :key="a.kind + (a.mount ?? '')">{{ describeAlert(a) }}</li>
    </ul>
  </button>
</template>
