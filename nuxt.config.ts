import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {getIcons} from '@iconify/utils';
import {
    DEFAULT_LOCALE,
    LOCALE_DEFINITIONS,
} from './packages/i18n-core';
import {isPdfjsPackageId} from './scripts/lib/pdfjs-package-path.mjs';
import {
    isSentryDiagnosticsBuild,
    resolveSentryBuildIdentity,
    resolveSentryBuildTarget,
} from './packages/contracts/diagnostics/releaseIdentity.js';

const requireFromConfig = createRequire(import.meta.url);

type TIconifyCollection = Parameters<typeof getIcons>[0];

function isIconifyCollection(value: unknown): value is TIconifyCollection {
    return typeof value === 'object'
        && value !== null
        && typeof Reflect.get(value, 'prefix') === 'string'
        && typeof Reflect.get(value, 'icons') === 'object';
}

// Nuxt Icon inlines whole Iconify collections into the Nitro server bundle (`ph` alone is
// ~4.5 MB of JSON), so the server bundle is narrowed to the same allowlist the client ships.
// An icon rendered without being listed here would resolve from neither bundle, hence the throw.
function buildIconBundles(iconNames: string[]) {
    const namesByPrefix = new Map<string, string[]>();
    for (const iconName of iconNames) {
        const segments = iconName.split(':');
        const [prefix, name] = segments;
        if (segments.length !== 2 || !prefix || !name) {
            throw new Error(`Invalid bundled icon name: ${iconName}`);
        }
        namesByPrefix.set(prefix, [...(namesByPrefix.get(prefix) ?? []), name]);
    }

    const collections = [...namesByPrefix].map(([prefix, names]) => {
        const source: unknown = requireFromConfig(`@iconify-json/${prefix}/icons.json`);
        if (!isIconifyCollection(source)) {
            throw new Error(`Unreadable icon collection: @iconify-json/${prefix}`);
        }

        const subset = getIcons(source, names, true);
        if (!subset) {
            throw new Error(`Unreadable icon collection: @iconify-json/${prefix}`);
        }

        const missing = subset.not_found ?? [];
        if (missing.length > 0) {
            throw new Error(`Icons missing from @iconify-json/${prefix}: ${missing.join(', ')}`);
        }
        return subset;
    });

    return {
        serverBundle: {collections},
        clientBundle: {icons: iconNames},
    };
}

function isInvalidNuxtUiResizableImport(entry: unknown) {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const from = Reflect.get(entry, 'from');
    const name = Reflect.get(entry, 'name');
    return typeof name === 'string'
        && typeof from === 'string'
        && name === 'options'
        && from.includes('@nuxt/ui/dist/runtime/composables/useResizable');
}

const isVercelBuildOutput = process.env.VERCEL === '1' || process.env.NOW_BUILDER === '1';
const isolatedNuxtOutputDir = process.env.EVB_NUXT_OUTPUT_DIR?.trim();
const packageJson = requireFromConfig('./package.json') as {version?: unknown};
const sentryDiagnosticsEligible = isSentryDiagnosticsBuild(process.env);
const sentryBuildIdentity = sentryDiagnosticsEligible
    ? resolveSentryBuildIdentity({
        target: resolveSentryBuildTarget(process.env),
        version: typeof packageJson.version === 'string' ? packageJson.version : undefined,
        environment: process.env,
    })
    : null;
const sentryBrowserDsn = sentryDiagnosticsEligible
    ? process.env.SENTRY_BROWSER_DSN?.trim() ?? ''
    : '';
const sentryNitroDsn = sentryDiagnosticsEligible
    ? process.env.SENTRY_NITRO_DSN?.trim() ?? ''
    : '';
const sentryNitroIdentity = sentryBuildIdentity?.target === 'web'
    ? sentryBuildIdentity
    : null;
const sentryNitroPolicy = Object.freeze({
    enabled: process.env.EVB_SENTRY_NITRO_ENABLED === '1',
    legitimateInterestsApproved: process.env.EVB_SENTRY_NITRO_LIA_APPROVED === '1',
    legalNoticePublished: process.env.EVB_SENTRY_NITRO_NOTICE_PUBLISHED === '1',
    dpaExecuted: process.env.EVB_SENTRY_NITRO_DPA_EXECUTED === '1',
    accountHardened: process.env.EVB_SENTRY_NITRO_ACCOUNT_HARDENED === '1',
    retentionReady: process.env.EVB_SENTRY_NITRO_RETENTION_READY === '1',
    objectionReady: process.env.EVB_SENTRY_NITRO_OBJECTION_READY === '1',
});
const sentryNitroBuildConfiguration = Object.freeze({
    dsn: sentryNitroDsn,
    identity: sentryNitroIdentity,
    policy: sentryNitroPolicy,
});
function resolveSentryEuIngestOrigin(dsn: string) {
    try {
        const url = new URL(dsn);
        return url.protocol === 'https:'
            && /(?:^|\.)ingest\.de\.sentry\.io$/u.test(url.hostname)
            && url.username.length > 0
            && url.password.length === 0
            && /^\/\d+\/?$/u.test(url.pathname)
            ? url.origin
            : '';
    } catch {
        return '';
    }
}
const sentryBrowserIngestOrigin = resolveSentryEuIngestOrigin(sentryBrowserDsn);
const nitroOutput = isVercelBuildOutput
    // Let Nitro's Vercel preset keep Build Output API directories as static/ and functions/.
    ? {dir: '.vercel/output'}
    : isolatedNuxtOutputDir
        ? {
            dir: isolatedNuxtOutputDir,
            publicDir: `${isolatedNuxtOutputDir}/public`,
            serverDir: `${isolatedNuxtOutputDir}/server`,
        }
        : {
            dir: 'nuxt-output',
            publicDir: 'nuxt-output/public',
            serverDir: 'nuxt-output/server',
        };

const isDev = process.env.NODE_ENV !== 'production';
const isolatedNuxtBuildDir = process.env.EVB_NUXT_BUILD_DIR?.trim();
const isolatedNuxtViteCacheDir = process.env.EVB_NUXT_VITE_CACHE_DIR?.trim();
const enableNuxtCompatibilityV5 = process.env.EVB_NUXT_COMPATIBILITY_VERSION === '5';
const appShellCacheHeaders = {
    'cache-control': 'no-store, max-age=0, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
} as const;
const appContentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' blob:${isDev ? ' ws: wss:' : ''}${sentryBrowserIngestOrigin ? ` ${sentryBrowserIngestOrigin}` : ''}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
].join('; ');
const appSecurityHeaders = {
    'Content-Security-Policy': appContentSecurityPolicy,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
} as const;
const withAppSecurityHeaders = (headers: Record<string, string> = {}) => ({
    ...appSecurityHeaders,
    ...headers,
});
const appDir = fileURLToPath(new URL('./app', import.meta.url));
const knownSourcemapWarningPlugins = new Set([
    '@tailwindcss/vite:generate:build',
    'nuxt:module-preload-polyfill',
    'nuxt:server-devonly:transform',
]);

interface IRollupLog {
    code?: string | undefined;
    message: string;
    plugin?: string | undefined;
}

function isKnownSourcemapWarning(log: IRollupLog) {
    if (log.code !== 'SOURCEMAP_BROKEN') {
        return false;
    }

    const plugin = log.plugin ?? log.message?.match(/a plugin \(([^)]+)\)/u)?.[1];
    return plugin ? knownSourcemapWarningPlugins.has(plugin) : false;
}

export default defineNuxtConfig({
    ...(isolatedNuxtBuildDir ? {buildDir: isolatedNuxtBuildDir} : {}),
    ...(enableNuxtCompatibilityV5 ? {future: {compatibilityVersion: 5 as const}} : {}),

    app: {
        head: {
            meta: [
                { charset: 'utf-8' },
                { name: 'viewport', content: 'width=device-width, initial-scale=1' },
                { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
                { name: 'theme-color', content: '#1a1a1a', media: '(prefers-color-scheme: dark)' },
                { name: 'format-detection', content: 'telephone=no' },
            ],
            link: [
                {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '16x16',
                    href: isDev ? '/favicon-dev-16x16.png' : '/favicon-16x16.png?v=5',
                },
                {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '32x32',
                    href: isDev ? '/favicon-dev-32x32.png' : '/favicon-32x32.png?v=5',
                },
                {
                    rel: 'icon',
                    type: 'image/svg+xml',
                    href: isDev ? '/favicon-dev.svg' : '/favicon.svg?v=5',
                },
                {
                    rel: 'icon',
                    type: 'image/x-icon',
                    href: isDev ? '/favicon-dev.ico' : '/favicon.ico?v=5',
                },
                {
                    rel: 'apple-touch-icon',
                    sizes: '180x180',
                    href: '/apple-touch-icon.png',
                },
            ],
        },
    },

    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
        '@nuxt/icon',
        '@nuxtjs/i18n',
    ],

    components: [
        {
            path: '~/components',
            pathPrefix: false,
        },
        {
            path: '~/modules/pdf-viewer/components',
            pathPrefix: false,
            extensions: ['vue'],
        },
        {
            path: '~/modules/workspace-shell/components',
            pathPrefix: false,
            extensions: ['vue'],
        },
    ],

    css: [
        '~/assets/css/app-shell-critical.scss',
        '~/assets/css/main.css',
    ],

    // Keep Nuxt's server renderer available for prerender/build-time output and
    // Nitro endpoints. Personalized browser state is client-seeded, not
    // request-time SSR-rendered.
    ssr: true,

    // Disable SPA loading template - causes jerky size changes due to scrollbar appearance
    spaLoadingTemplate: false,

    devtools: {enabled: false},

    devServer: {port: 3235},

    ignore: [
        'resources/djvulibre/**',
        'resources/poppler/**',
        'resources/qpdf/**',
        'resources/tesseract/**',
    ],

    colorMode: {
        preference: 'light',
        // The settings capability owns the hardened SSR bootstrap cookie.
        // Color mode keeps its client preference in localStorage so the module
        // never rewrites that cookie without Secure/SameSite/expiry attributes.
        storage: 'localStorage',
        disableTransition: true,
    },

    hooks: {
        // Nuxt UI's scanner can leak a non-exported `options` symbol from useResizable into #imports.
        // Removing it here prevents runtime ESM import errors during app bootstrap.
        'imports:extend': (imports) => {
            for (let index = imports.length - 1; index >= 0; index -= 1) {
                if (isInvalidNuxtUiResizableImport(imports[index])) {
                    imports.splice(index, 1);
                }
            }
        },
    },

    alias: {
        '@app': appDir,
        '@contracts': fileURLToPath(new URL('./packages/contracts', import.meta.url)),
        '@pdf-core': fileURLToPath(new URL('./packages/pdf-core', import.meta.url)),
        '@i18n-core': fileURLToPath(new URL('./packages/i18n-core', import.meta.url)),
        '@i18n-app': fileURLToPath(new URL('./packages/i18n-app', import.meta.url)),
        '@releaseSelection': fileURLToPath(new URL('./packages/release-selection', import.meta.url)),
        '@root-package': fileURLToPath(new URL('./package.json', import.meta.url)),
        '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },

    runtimeConfig: {
        sentry: {
            nitroDsn: sentryNitroDsn,
            release: sentryNitroIdentity?.release ?? '',
            dist: sentryNitroIdentity?.dist ?? '',
            environment: sentryNitroIdentity?.environment ?? '',
            policy: sentryNitroPolicy,
        },
        analytics: {
            // Keep writes explicitly opt-in so local dev and preview traffic
            // never hits the production analytics dataset by accident.
            databaseUrl: process.env.NUXT_ANALYTICS_DATABASE_URL || process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL || '',
            writeEnabled: process.env.NUXT_ANALYTICS_WRITE_ENABLED === '1' || process.env.ANALYTICS_WRITE_ENABLED === '1',
            allowedHosts: (process.env.NUXT_ANALYTICS_ALLOWED_HOSTS || process.env.ANALYTICS_ALLOWED_HOSTS || '')
                .split(',')
                .map(host => host.trim())
                .filter(Boolean),
        },
        public: {
            sentry: {
                dsn: sentryBrowserDsn,
                release: sentryBuildIdentity?.release ?? '',
                dist: sentryBuildIdentity?.dist ?? '',
                environment: sentryBuildIdentity?.environment ?? '',
            },
            analyticsEnabled: process.env.NUXT_PUBLIC_ANALYTICS_ENABLED === '1',
            landingUrl: process.env.NUXT_PUBLIC_LANDING_URL || 'https://evb-viewer.com',
            siteUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://web.evb-viewer.com',
        },
    },

    routeRules: {
        '/robots.txt': { prerender: true, headers: withAppSecurityHeaders() },
        '/sitemap.xml': { prerender: true, headers: withAppSecurityHeaders() },
        '/electron': {
            prerender: true,
            ssr: false,
            headers: withAppSecurityHeaders({
                ...appShellCacheHeaders,
                'X-Robots-Tag': 'noindex, nofollow',
            }),
        },
        '/electron/**': {
            prerender: true,
            ssr: false,
            headers: withAppSecurityHeaders({
                ...appShellCacheHeaders,
                'X-Robots-Tag': 'noindex, nofollow',
            }),
        },
        '/': {
            prerender: true,
            headers: withAppSecurityHeaders(appShellCacheHeaders),
        },
        '/_payload.json': {
            headers: withAppSecurityHeaders(appShellCacheHeaders),
        },
        '/**/_payload.json': {
            headers: withAppSecurityHeaders(appShellCacheHeaders),
        },
        '/_nuxt/builds/**': {
            headers: withAppSecurityHeaders(appShellCacheHeaders),
        },
        '/workspace': {
            // Compatibility entry only. Keep the browser workspace SSR/SSG surface
            // canonical at `/` so refresh does not hit a SPA-only shell.
            redirect: { to: '/', statusCode: 302 },
            headers: withAppSecurityHeaders({
                ...appShellCacheHeaders,
                'X-Robots-Tag': 'noindex, nofollow',
            }),
        },
        '/mobile-reader-proof': {
            prerender: true,
            headers: withAppSecurityHeaders(appShellCacheHeaders),
        },
        '/privacy': {
            prerender: true,
            headers: withAppSecurityHeaders(),
        },
        '/api/analytics/events': {
            prerender: false,
            headers: withAppSecurityHeaders(),
        },
        '/**': {
            headers: appSecurityHeaders,
        },
    },

    sourcemap: {
        server: sentryDiagnosticsEligible,
        client: sentryDiagnosticsEligible,
    },

    // TypeScript 6 enables noUncheckedSideEffectImports by default. The SFC lane
    // cannot satisfy it because `vite` is not a resolvable root dependency under
    // pnpm's strict layout, so the `import "vite/client"` in Nuxt's generated
    // .nuxt/types/builder-env.d.ts never loads its `declare module '*.css'` and
    // '*.scss' wildcards. Bundler resolution, Stylelint/asset checks, and the
    // strict build continue to validate that these stylesheets exist.
    // Remove when `vite/client` resolves in the main app type environment (a
    // declared root `vite` dependency, or Nuxt emitting the style declarations
    // itself); then this lane inherits the TS6 default again.
    typescript: {tsConfig: {compilerOptions: {noUncheckedSideEffectImports: false}}},

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS,
        defaultLocale: DEFAULT_LOCALE,
        baseUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://web.evb-viewer.com',
        lazy: true,
        langDir: 'i18n/runtime-locales/',
        strategy: 'no_prefix',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'i18n_redirected',
            cookieSecure: process.env.NODE_ENV === 'production',
            redirectOn: 'root',
        },
    },

    icon: buildIconBundles([
        'ph:arrow-down',
        'ph:arrow-down-left',
        'ph:arrow-down-right',
        'ph:arrow-left',
        'ph:arrow-right',
        'ph:arrow-up',
        'ph:arrow-up-left',
        'ph:text-b-bold',
        'ph:book-open',
        'ph:bookmark',
        'ph:bounding-box',
        'ph:check',
        'ph:caret-down',
        'ph:caret-left',
        'ph:caret-right',
        'ph:caret-up',
        'ph:caret-up-down',
        'ph:caret-double-left',
        'ph:caret-double-right',
        'ph:warning-circle',
        'ph:check-circle',
        'ph:stop',
        'ph:stop-circle',
        'ph:x-circle',
        'ph:clock',
        'ph:scan',
        'ph:text-aa',
        'ph:text-align-center',
        'ph:copy',
        'ph:stack-plus',
        'ph:crop',
        'ph:dots-three',
        'ph:dot-outline',
        'ph:arrow-square-out',
        'ph:eye',
        'ph:eye-slash',
        'ph:file',
        'ph:file-plus',
        'ph:file-text',
        'ph:files',
        'ph:folder',
        'ph:folder-open',
        'ph:gauge',
        'ph:globe',
        'ph:hand',
        'ph:hash',
        'ph:highlighter',
        'ph:image',
        'ph:images',
        'ph:info',
        'ph:text-italic',
        'ph:lightbulb',
        'ph:lightning',
        'ph:list',
        'ph:circle-notch',
        'ph:rows',
        'ph:tree-view',
        'ph:crosshair-simple',
        'ph:chat-circle',
        'ph:chat-circle-text',
        'ph:chat',
        'ph:chat-circle-dots',
        'ph:sparkle',
        'ph:monitor',
        'ph:download-simple',
        'ph:moon',
        'ph:arrows-out-line-horizontal',
        'ph:arrows-out-line-vertical',
        'ph:sidebar-simple',
        'ph:pen-nib',
        'ph:plus',
        'ph:pencil',
        'ph:printer',
        'ph:pencil-simple-line',
        'ph:dots-six-vertical',
        'ph:arrows-clockwise',
        'ph:floppy-disk',
        'ph:floppy-disk-back',
        'ph:magnifying-glass',
        'ph:scroll',
        'ph:sun',
        'ph:cursor-text',
        'ph:trash',
        'ph:text-t',
        'ph:warning',
        'ph:arrow-u-up-left',
        'ph:upload',
        'ph:user',
        'ph:x',
        'ph:magnifying-glass-plus',
        'ph:play',
        'ph:frame-corners',
        'ph:magic-wand',
        'ph:arrow-u-up-right',
        'ph:text-underline',
        'ph:text-strikethrough',
        'ph:waves',
        'ph:square',
        'ph:circle',
        'ph:clipboard-text',
        'ph:minus',
        'ph:arrow-up-right',
        'ph:arrow-line-right',
        'ph:square-split-horizontal',
        'ph:square-split-vertical',
        'ph:gear',
        'ph:sliders-horizontal',
        'ph:note',
        'circle-flags:gb',
        'circle-flags:ru',
        'circle-flags:fr',
        'circle-flags:de',
        'circle-flags:es',
        'circle-flags:it',
        'circle-flags:pt',
        'circle-flags:br',
        'circle-flags:nl',
        'ph:export',
        'ph:file-arrow-down',
        'ph:arrow-clockwise',
        'ph:arrow-counter-clockwise',
        'ph:corners-out',
        'ph:corners-in',
    ]),

    vite: {
        ...(isolatedNuxtViteCacheDir ? {cacheDir: isolatedNuxtViteCacheDir} : {}),
        worker: {
            format: 'es',
            rolldownOptions: {
                output: {sourcemapExcludeSources: sentryDiagnosticsEligible},
            },
        },
        css: {
            preprocessorOptions: {
                scss: {
                    additionalData: '@use "~/assets/css/transitions" as *;\n',
                },
            },
        },
        build: {
            sourcemap: sentryDiagnosticsEligible,
            // Electron desktop bundle tolerates larger chunks, but still split heavy vendors to keep rebuilds snappier.
            chunkSizeWarningLimit: 1400,
            rollupOptions: {
                onLog(level, log, handler) {
                    if (level === 'warn' && isKnownSourcemapWarning(log)) {
                        return;
                    }

                    handler(level, log);
                },
                output: {
                    sourcemapExcludeSources: sentryDiagnosticsEligible,
                    codeSplitting: {groups: [
                        {
                            name: 'vendor-pdfjs',
                            test: isPdfjsPackageId,
                        },
                        {
                            name: 'vendor-pdf-lib',
                            test: /node_modules[\\/]pdf-lib[\\/]/,
                        },
                        {
                            name: 'vendor-vueuse',
                            test: /node_modules[\\/]@vueuse[\\/](?:core|math)[\\/]/,
                        },
                    ]},
                },
            },
        },
        optimizeDeps: {
            include: [
                '@vueuse/core',
                '@vueuse/math',
                'agentation-vue3',
                'devalue',
                'errx',
                'es-toolkit/array',
                'es-toolkit/math',
                'es-toolkit/object',
                'es-toolkit/predicate',
                'es-toolkit/promise',
                'es-toolkit/string',
                'unhead',
                '@unhead/vue',
                'vue-router',
                'ofetch',
                'hookable',
                'unctx',
                'klona',
                'scule',
                '@vue/devtools-api',
                '@iconify/vue',
                'pdf-lib',
                'utif',
            ],
            exclude: ['pdfjs-dist'],
        },
        server: {
            watch: {usePolling: false},
            warmup: {
                // Pre-transform the initial route/module graph to reduce Electron cold-start blank time in dev.
                clientFiles: [
                    `${appDir}/app.vue`,
                    `${appDir}/pages/index.vue`,
                    `${appDir}/composables/useSettings.ts`,
                    `${appDir}/composables/useTypedI18n.ts`,
                ],
            },
        },
    },

    nitro: {
        sourceMap: sentryDiagnosticsEligible,
        // The server-only PDF.js runtime uses a top-level dynamic import. The
        // desktop build runs on Node 24, so keep Nitro's final server transform
        // in an ESM target that preserves that syntax for prerendering.
        esbuild: {
            options: {
                target: 'esnext',
            },
        },
        replace: {
            __EVB_SENTRY_NITRO_BUILD_CONFIGURATION__: JSON.stringify(sentryNitroBuildConfiguration),
        },
        // Vercel's Nuxt builder only recognizes Build Output API artifacts from
        // `.vercel/output`; local desktop flows still consume `nuxt-output`.
        output: nitroOutput,
        ...(isVercelBuildOutput ? {
            // Vercel's file tracer can omit modules re-exported only by this
            // package's barrel, which leaves the server function unable to boot.
            externals: {inline: ['@iconify/utils']},
        } : {}),
        prerender: {
            routes: [
                '/',
                '/electron',
                '/workspace',
                '/mobile-reader-proof',
                '/privacy',
                '/robots.txt',
                '/sitemap.xml',
            ],
        },
    },

    compatibilityDate: '2025-01-01',
});
