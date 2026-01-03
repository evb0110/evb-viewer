export default defineNuxtConfig({
    modules: ['@nuxt/eslint'],

    ssr: true,

    devtools: { enabled: false },

    devServer: {
        port: 3235,
    },

    nitro: {
        preset: 'node-server',
    },

    compatibilityDate: '2025-01-01',
});
