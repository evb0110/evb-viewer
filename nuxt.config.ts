export default defineNuxtConfig({
  modules: ['nuxt-electron'],

  ssr: true,

  devtools: { enabled: false },

  electron: {
    build: [
      {
        entry: 'electron/main.ts',
      },
    ],
  },

  nitro: {
    preset: 'node-server',
    serveStatic: true,
  },

  compatibilityDate: '2025-01-01',
})
