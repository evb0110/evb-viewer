// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
    ],

    devtools: { enabled: true },

    css: ['~/assets/css/main.css'],

    runtimeConfig: {
        githubApiBase: process.env.NUXT_GITHUB_API_BASE || 'https://api.github.com',
        githubOwner: process.env.NUXT_GITHUB_OWNER || 'evb0110',
        githubRepo: process.env.NUXT_GITHUB_REPO || 'electron-nuxt',
        githubToken: process.env.NUXT_GITHUB_TOKEN || '',
    },

    routeRules: {
        '/': { prerender: true },
        '/features': { prerender: true },
        '/docs': { prerender: true },
        '/api/releases/latest': { swr: 3600 },
    },

    compatibilityDate: '2025-01-15',

    eslint: { config: { stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs',
    } } },
});
