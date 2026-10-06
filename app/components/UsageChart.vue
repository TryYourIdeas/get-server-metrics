<script setup lang="ts">
const props = defineProps<{ title: string; points: { ts: string; value: number }[]; total?: number }>()
const W = 600
const H = 120
const TICKS = [100, 50, 0]
const path = computed(() => {
  const p = props.points
  if (p.length < 2) return ''
  const t0 = new Date(p[0]!.ts).getTime()
  const span = new Date(p[p.length - 1]!.ts).getTime() - t0 || 1
  return p.map((pt, i) => {
    const x = ((new Date(pt.ts).getTime() - t0) / span) * W
    const y = H - (Math.min(100, Math.max(0, pt.value)) / 100) * H
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
})
const latest = computed(() => {
  const last = props.points[props.points.length - 1]
  return last ? latestLabel(last.value, props.total) : ''
})
</script>

<template>
  <div class="rounded border border-slate-200 bg-white p-3">
    <h3 class="mb-2 flex justify-between text-sm font-semibold">
      <span>{{ title }}</span>
      <span class="font-normal text-slate-600">{{ latest }}</span>
    </h3>
    <div v-if="path" class="flex gap-2">
      <div class="flex h-28 w-24 shrink-0 flex-col justify-between text-right text-xs leading-none text-slate-500">
        <span v-for="t in TICKS" :key="t">{{ axisLabel(t, total) }}</span>
      </div>
      <svg :viewBox="`0 0 ${W} ${H}`" class="h-28 w-full" preserveAspectRatio="none">
        <line v-for="t in TICKS" :key="t" x1="0" x2="100%" :y1="H - (t / 100) * H" :y2="H - (t / 100) * H" stroke="currentColor" stroke-width="1" class="text-slate-200" vector-effect="non-scaling-stroke" />
        <path :d="path" fill="none" stroke="currentColor" stroke-width="2" class="text-sky-600" vector-effect="non-scaling-stroke" />
      </svg>
    </div>
    <p v-else class="py-8 text-center text-sm text-slate-500">Not enough data yet — a reading arrives every few minutes, or click Check now.</p>
  </div>
</template>
