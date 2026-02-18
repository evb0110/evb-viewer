/* eslint-disable no-restricted-imports */
import { LOCALE_DEFINITIONS } from './app/i18n/locales';
import { DEFAULT_LOCALE } from './app/i18n/locale-codes';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    modules: [
        '@nuxt/ui',
        '@nuxtjs/i18n',
    ],

    devtools: { enabled: true },

    css: ['~/assets/css/main.css'],

    runtimeConfig: {
        githubApiBase: process.env.NUXT_GITHUB_API_BASE || 'https://api.github.com',
        githubOwner: process.env.NUXT_GITHUB_OWNER || 'evb0110',
        githubRepo: process.env.NUXT_GITHUB_REPO || 'evb-viewer',
        githubToken: process.env.NUXT_GITHUB_TOKEN || '',
        public: {siteUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.vercel.app'},
    },

    routeRules: {
        '/': { isr: 600 },
        '/features': { prerender: true },
        '/docs': { prerender: true },
        '/robots.txt': { prerender: true },
        '/sitemap.xml': { prerender: true },
    },

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS,
        defaultLocale: DEFAULT_LOCALE,
        langDir: 'locales/',
        strategy: 'no_prefix',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'i18n_locale',
        },
    },

    icon: {clientBundle: {icons: [
        'circle-flags:gb',
        'circle-flags:ru',
        'circle-flags:fr',
        'circle-flags:de',
        'circle-flags:es',
        'circle-flags:it',
        'circle-flags:pt',
        'circle-flags:nl',
    ]}},

    compatibilityDate: '2025-01-15',
});
