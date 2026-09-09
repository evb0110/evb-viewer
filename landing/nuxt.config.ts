import {fileURLToPath} from 'node:url';

import {defineNuxtConfig as defineNuxtConfigBase} from 'nuxt/config';

import {DEFAULT_LOCALE, LOCALE_CODES} from '../packages/i18n-core/localeCodes';
import {LOCALE_DEFINITIONS} from '../packages/i18n-core/localeDefinitions';

// Nuxt 4.4.7's config declaration currently loses the helper call signature.
const defineNuxtConfig = defineNuxtConfigBase as <T extends Record<string, unknown>>(config: T) => T;
const isolatedNuxtBuildDir = process.env.EVB_NUXT_BUILD_DIR?.trim();
const enableNuxtCompatibilityV5 = process.env.EVB_NUXT_COMPATIBILITY_VERSION === '5';
const landingContentSecurityPolicy = [
    'default-src \'self\'',
    'script-src \'self\' \'unsafe-inline\'',
    'script-src-attr \'none\'',
    'style-src \'self\' \'unsafe-inline\'',
    'img-src \'self\' data:',
    'font-src \'self\' data:',
    'connect-src \'self\'',
    'frame-src \'none\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    'frame-ancestors \'none\'',
    'form-action \'self\'',
].join('; ');
const landingSecurityHeaders = {
    'Content-Security-Policy': landingContentSecurityPolicy,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
} as const;
const withLandingSecurityHeaders = (headers: Record<string, string> = {}) => ({
    ...landingSecurityHeaders,
    ...headers,
});

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    ...(isolatedNuxtBuildDir ? {buildDir: isolatedNuxtBuildDir} : {}),
    ...(enableNuxtCompatibilityV5 ? {future: {compatibilityVersion: 5 as const}} : {}),

    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
        '@nuxtjs/i18n',
        '@nuxtjs/sitemap',
    ],

    devtools: { enabled: true },

    devServer: { port: 3777 },

    typescript: { tsConfig: { compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        useUnknownInCatchVariables: true,
        strictBuiltinIteratorReturn: true,
        verbatimModuleSyntax: true,
        moduleDetection: 'force',
        isolatedModules: true,
        forceConsistentCasingInFileNames: true,
        skipLibCheck: true,
    } } },

    css: ['~/assets/css/main.css'],

    alias: {
        '@contracts': fileURLToPath(new URL('../packages/contracts', import.meta.url)),
        '@i18n-core': fileURLToPath(new URL('../packages/i18n-core', import.meta.url)),
        '@releaseSelection': fileURLToPath(new URL('../packages/release-selection', import.meta.url)),
    },

    runtimeConfig: {
        databaseUrl: process.env.DATABASE_URL,
        githubApiBase: process.env.NUXT_GITHUB_API_BASE || 'https://api.github.com',
        githubOwner: process.env.NUXT_GITHUB_OWNER || 'evb0110',
        githubRepo: process.env.NUXT_GITHUB_REPO || 'evb-viewer',
        githubToken: process.env.NUXT_GITHUB_TOKEN || '',
        releaseMirrorBaseUrl: process.env.NUXT_RELEASE_MIRROR_BASE_URL
            || 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/releases',
        releaseStableTags: process.env.NUXT_RELEASE_STABLE_TAGS || '',
        releaseWithdrawnTags: process.env.NUXT_RELEASE_WITHDRAWN_TAGS || '',
        releaseCanaryTag: process.env.NUXT_RELEASE_CANARY_TAG || '',
        releaseCanaryPercent: process.env.NUXT_RELEASE_CANARY_PERCENT || '0',
        public: {
            siteUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.com',
            webAppUrl: process.env.NUXT_PUBLIC_WEB_APP_URL || 'https://web.evb-viewer.com',
        },
    },

    routeRules: {
        '/': { headers: withLandingSecurityHeaders({'cache-control': 'private, no-store, max-age=0'}) },
        '/features': {
            prerender: true,
            headers: withLandingSecurityHeaders(),
        },
        '/docs': {
            prerender: true,
            headers: withLandingSecurityHeaders(),
        },
        '/privacy': {
            prerender: true,
            headers: withLandingSecurityHeaders(),
        },
        ...Object.fromEntries(
            LOCALE_CODES
                .filter(code => code !== DEFAULT_LOCALE)
                .flatMap(code => [
                    [
                        `/${code}`,
                        { headers: withLandingSecurityHeaders({'cache-control': 'private, no-store, max-age=0'}) },
                    ],
                    [
                        `/${code}/features`,
                        {
                            prerender: true,
                            headers: withLandingSecurityHeaders(),
                        },
                    ],
                    [
                        `/${code}/docs`,
                        {
                            prerender: true,
                            headers: withLandingSecurityHeaders(),
                        },
                    ],
                    [
                        `/${code}/privacy`,
                        {
                            prerender: true,
                            headers: withLandingSecurityHeaders(),
                        },
                    ],
                ]),
        ),
        '/robots.txt': {
            prerender: true,
            headers: withLandingSecurityHeaders(),
        },
        '/api/**': {headers: withLandingSecurityHeaders({'cache-control': 'private, no-store, max-age=0'})},
        '/**': {headers: landingSecurityHeaders},
    },

    sitemap: {
        autoI18n: true,
        xslColumns: [
            {
                label: 'URL',
                width: '65%',
            },
            {
                label: 'Last Modified',
                select: 'sitemap:lastmod',
                width: '35%',
            },
        ],
    },

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS.map(locale => ({ ...locale })),
        defaultLocale: DEFAULT_LOCALE,
        baseUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.com',
        langDir: 'locales/',
        strategy: 'prefix_except_default',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'i18n_locale',
            cookieSecure: process.env.NODE_ENV === 'production',
            redirectOn: 'root',
        },
    },

    icon: {clientBundle: {icons: [
        'ph:arrow-right',
        'ph:download',
        'ph:files',
        'ph:globe',
        'ph:folder-open',
        'ph:sidebar',
        'ph:list',
        'ph:pen-nib',
        'ph:scissors',
        'ph:text-aa',
        'circle-flags:gb',
        'circle-flags:ru',
        'circle-flags:fr',
        'circle-flags:de',
        'circle-flags:es',
        'circle-flags:it',
        'circle-flags:pt',
        'circle-flags:br',
        'circle-flags:nl',
        'simple-icons:github',
        'simple-icons:microsoft',
    ]}},

    compatibilityDate: '2025-01-15',
});
