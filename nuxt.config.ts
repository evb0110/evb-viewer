export default defineNuxtConfig({
    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
        '@nuxt/icon',
    ],

    css: ['~/assets/css/main.css'],

    ssr: false,

    devtools: {enabled: false},

    devServer: {port: 3235},

    nitro: {preset: 'node-server'},

    colorMode: {preference: 'light'},

    icon: {
        serverBundle: {collections: ['lucide']},
        clientBundle: {icons: [
            'lucide:arrow-down',
            'lucide:arrow-up',
            'lucide:book-open',
            'lucide:check',
            'lucide:chevron-down',
            'lucide:chevron-left',
            'lucide:chevron-right',
            'lucide:chevron-up',
            'lucide:chevrons-left',
            'lucide:chevrons-right',
            'lucide:file-text',
            'lucide:folder-open',
            'lucide:hand',
            'lucide:layout-grid',
            'lucide:list',
            'lucide:loader-circle',
            'lucide:moon',
            'lucide:panel-left',
            'lucide:search',
            'lucide:search-x',
            'lucide:text-cursor',
            'lucide:move-horizontal',
            'lucide:move-vertical',
            'lucide:save',
            'lucide:x',
            'lucide:zoom-in',
        ]},
    },

    vite: {
        build: {rollupOptions: {output: {manualChunks: {'vendor-pdfjs': ['pdfjs-dist']}}}},
        optimizeDeps: {
            include: [
                '@vueuse/core',
                'devalue',
                'unhead',
                '@unhead/vue',
                'vue-router',
                'ofetch',
                'hookable',
                'unctx',
                'klona',
                'destr',
                'scule',
                '@vue/devtools-api',
            ],
            exclude: ['pdfjs-dist'],
        },
        server: {watch: {usePolling: false}},
    },

    compatibilityDate: '2025-01-01',
});
