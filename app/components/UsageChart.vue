<script setup lang="ts">
const props = defineProps<{ title: string; points: { ts: string; value: number }[] }>()
const W = 600
const H = 120
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
</script>

<template>
  <div class="rounded border border-slate-200 bg-white p-3">
    <h3 class="mb-2 text-sm font-semibold">{{ title }}</h3>
    <svg v-if="path" :viewBox="`0 0 ${W} ${H}`" class="h-28 w-full" preserveAspectRatio="none">
      <path :d="path" fill="none" stroke="currentColor" stroke-width="2" class="text-sky-600" vector-effect="non-scaling-stroke" />
    </svg>
    <p v-else class="py-8 text-center text-sm text-slate-500">Not enough data yet — samples are taken every minute.</p>
  </div>
</template>
