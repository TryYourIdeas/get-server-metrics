import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  // The shared package ships TypeScript source, so it must be bundled instead of left as an external import.
  nitro: { externals: { inline: ['agent'] } },
  build: { transpile: ['agent'] }
})
