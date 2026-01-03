export default defineNuxtConfig({
    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
        '@nuxt/icon',
    ],

    css: ['~/assets/css/main.css'],

    ssr: true,

    devtools: {enabled: false},

    devServer: {port: 3235},

    nitro: {preset: 'node-server'},

    colorMode: {preference: 'light'},

    icon: {serverBundle: {collections: ['lucide']}},

    compatibilityDate: '2025-01-01',
});
