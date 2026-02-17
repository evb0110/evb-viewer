// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    modules: ['@nuxt/ui'],

    devtools: { enabled: true },

    css: ['~/assets/css/main.css'],

    runtimeConfig: {
        githubApiBase: process.env.NUXT_GITHUB_API_BASE || 'https://api.github.com',
        githubOwner: process.env.NUXT_GITHUB_OWNER || 'evb0110',
        githubRepo: process.env.NUXT_GITHUB_REPO || 'evb-viewer',
        githubToken: process.env.NUXT_GITHUB_TOKEN || '',
    },

    routeRules: {
        '/': { prerender: true },
        '/features': { prerender: true },
        '/docs': { prerender: true },
    },

    compatibilityDate: '2025-01-15',
});
