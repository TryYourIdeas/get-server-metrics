<script setup lang="ts">
const props = defineProps<{ label: string; percent: number; detail?: string }>()
const pct = computed(() => Math.min(100, Math.max(0, props.percent)))
const color = computed(() => pct.value >= 90 ? 'bg-red-500' : pct.value >= 70 ? 'bg-amber-500' : 'bg-emerald-500')
</script>

<template>
  <div>
    <div class="flex justify-between text-sm">
      <span class="font-medium">{{ label }}</span>
      <span>{{ pct.toFixed(1) }}% <span v-if="detail" class="text-slate-500">· {{ detail }}</span></span>
    </div>
    <div class="mt-1 h-3 w-full overflow-hidden rounded bg-slate-200">
      <div class="h-full transition-all" :class="color" :style="{ width: pct + '%' }" />
    </div>
  </div>
</template>
