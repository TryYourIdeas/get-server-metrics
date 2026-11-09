<script setup lang="ts">
import { resolveThresholds, THRESHOLD_KEYS, type Thresholds } from 'agent/protocol'
import { fieldsFrom, parseDefaultsForm, parseOverrideForm, type ThresholdFields } from '~/utils/thresholds-form'

type SettingsResponse = { defaults: Thresholds; overrides: Record<string, Partial<Thresholds>>; builtIn: Thresholds }

const LABELS: Record<keyof Thresholds, string> = {
  cpuPercent: 'CPU %',
  cpuConsecutive: 'CPU checks in a row',
  memoryPercent: 'Memory %',
  diskPercent: 'Disk %'
}

const { data: settings, refresh } = await useFetch<SettingsResponse>('/api/thresholds')
const { data: hostsData } = await useFetch<{ hosts: { hostId: string }[] }>('/api/hosts')

const defaultFields = reactive<ThresholdFields>(fieldsFrom(settings.value?.defaults))
const defaultErrors = ref<Partial<Record<keyof Thresholds, string>>>({})
const defaultMessage = ref('')
const savingDefaults = ref(false)

const editing = ref<string | null>(null)
const editFields = reactive<ThresholdFields>(fieldsFrom(null))
const editErrors = ref<Partial<Record<keyof Thresholds, string>>>({})
const hostMessage = ref('')
const savingHost = ref(false)

/** Every known machine, plus any machine that has an override but no longer reports. */
const hostIds = computed(() => [...new Set([...(hostsData.value?.hosts ?? []).map(h => h.hostId), ...Object.keys(settings.value?.overrides ?? {})])].sort())
const defaults = computed(() => settings.value?.defaults ?? settings.value?.builtIn)
const effective = (hostId: string) => (defaults.value ? resolveThresholds(defaults.value, settings.value?.overrides[hostId]) : undefined)
const overridden = (hostId: string, key: keyof Thresholds) => settings.value?.overrides[hostId]?.[key] !== undefined

const message = (err: unknown, fallback: string) => (err as { data?: { statusMessage?: string } })?.data?.statusMessage || fallback

async function saveDefaults() {
  defaultMessage.value = ''
  const r = parseDefaultsForm(defaultFields)
  defaultErrors.value = r.ok ? {} : r.errors
  if (!r.ok) return
  savingDefaults.value = true
  try {
    await $fetch('/api/thresholds', { method: 'PUT', body: r.value })
    await refresh()
    defaultMessage.value = 'Saved. Connected machines receive the new values within seconds.'
  } catch (err) {
    defaultMessage.value = message(err, 'Could not save the default thresholds.')
  } finally {
    savingDefaults.value = false
  }
}

function startEdit(hostId: string) {
  Object.assign(editFields, fieldsFrom(settings.value?.overrides[hostId]))
  editErrors.value = {}
  hostMessage.value = ''
  editing.value = hostId
}

async function saveOverride(hostId: string) {
  hostMessage.value = ''
  const r = parseOverrideForm(editFields)
  editErrors.value = r.ok ? {} : r.errors
  if (!r.ok) return
  await send(hostId, r.value === null ? undefined : r.value)
}

/** `override` undefined removes the override (the machine uses the defaults again). */
async function send(hostId: string, override?: Partial<Thresholds>) {
  savingHost.value = true
  try {
    const path = `/api/hosts/${encodeURIComponent(hostId)}/thresholds`
    if (override) await $fetch(path, { method: 'PUT', body: override })
    else await $fetch(path, { method: 'DELETE' })
    await refresh()
    editing.value = null
    hostMessage.value = override ? `Saved the thresholds for ${hostId}.` : `${hostId} now uses the default thresholds.`
  } catch (err) {
    hostMessage.value = message(err, `Could not change the thresholds for ${hostId}.`)
  } finally {
    savingHost.value = false
  }
}

useHead({ title: 'Triggers' })
</script>

<template>
  <main class="mx-auto max-w-4xl space-y-6 p-4">
    <header class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-bold">Alert triggers</h1>
      <NuxtLink to="/" class="rounded border border-slate-300 bg-white px-3 py-1 text-sm">Back to the dashboard</NuxtLink>
    </header>

    <section class="space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Default thresholds</h2>
      <p class="text-sm text-slate-600">Apply to every machine unless it has its own values below. An alert is raised when a value reaches the threshold.</p>
      <form class="grid gap-3 sm:grid-cols-4" @submit.prevent="saveDefaults">
        <label v-for="key in THRESHOLD_KEYS" :key="key" class="text-sm">
          {{ LABELS[key] }}
          <input v-model="defaultFields[key]" inputmode="decimal" class="mt-1 w-full rounded border border-slate-300 px-2 py-1" :aria-invalid="!!defaultErrors[key]">
          <span v-if="defaultErrors[key]" class="text-xs text-red-700" role="alert">{{ defaultErrors[key] }}</span>
        </label>
        <div class="sm:col-span-4">
          <button class="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-50" :disabled="savingDefaults">
            {{ savingDefaults ? 'Saving…' : 'Save defaults' }}
          </button>
          <span v-if="defaultMessage" class="ml-3 text-sm text-slate-700" role="status">{{ defaultMessage }}</span>
        </div>
      </form>
    </section>

    <section class="space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Machines</h2>
      <p v-if="hostMessage" class="text-sm text-slate-700" role="status">{{ hostMessage }}</p>
      <p v-if="!hostIds.length" class="text-sm text-slate-600">No machines have reported yet.</p>
      <ul class="divide-y divide-slate-100">
        <li v-for="id in hostIds" :key="id" class="py-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="font-medium">{{ id }}</p>
              <p v-if="effective(id)" class="text-sm text-slate-600">
                <span v-for="key in THRESHOLD_KEYS" :key="key" class="mr-3" :class="overridden(id, key) ? 'font-semibold text-sky-700' : ''">
                  {{ LABELS[key] }}: {{ effective(id)![key] }}
                </span>
              </p>
            </div>
            <div class="flex gap-2">
              <button class="rounded border border-slate-300 px-3 py-1 text-sm" :aria-label="`Edit ${id}`" @click="startEdit(id)">Edit</button>
              <button
                v-if="settings?.overrides[id]"
                class="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
                :disabled="savingHost"
                @click="send(id)"
              >Use defaults</button>
            </div>
          </div>
          <form v-if="editing === id" class="mt-3 grid gap-3 sm:grid-cols-4" @submit.prevent="saveOverride(id)">
            <label v-for="key in THRESHOLD_KEYS" :key="key" class="text-sm">
              {{ LABELS[key] }}
              <input
                v-model="editFields[key]"
                :placeholder="String(defaults?.[key] ?? '')"
                inputmode="decimal"
                class="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                :aria-invalid="!!editErrors[key]"
              >
              <span v-if="editErrors[key]" class="text-xs text-red-700" role="alert">{{ editErrors[key] }}</span>
            </label>
            <div class="sm:col-span-4 flex items-center gap-3">
              <button class="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-50" :disabled="savingHost">{{ savingHost ? 'Saving…' : 'Save' }}</button>
              <button type="button" class="text-sm text-slate-600 underline" @click="editing = null">Cancel</button>
              <span class="text-xs text-slate-500">Leave a field blank to use the default.</span>
            </div>
          </form>
        </li>
      </ul>
    </section>
  </main>
</template>
