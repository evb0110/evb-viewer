<template>
  <div class="landing-root">
    <UContainer
      class="landing-container"
      :class="{ 'landing-container-wide': isHomeRoute }"
    >
      <SiteHeader v-if="showSiteHeader" />
      <NuxtPage />
      <SiteFooter v-if="showSiteFooter" />
    </UContainer>
  </div>
</template>

<script setup lang="ts">
import {
    normalizeSiteUrl,
    SEO_IMAGE_PATH,
} from '~~/shared/seo';
import SiteFooter from '~/components/SiteFooter.vue';
import SiteHeader from '~/components/SiteHeader.vue';

const {
    t,
    locale,
} = useTypedI18n();
const route = useRoute();
const routeBaseName = useRouteBaseName();
const runtimeConfig = useRuntimeConfig();

const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
const ogImage = computed(() => `${siteUrl.value}${SEO_IMAGE_PATH}`);
const isHomeRoute = computed(() => route.path === '/' || routeBaseName(route) === 'index');
const showSiteHeader = computed(() => !isHomeRoute.value);
const showSiteFooter = computed(() => !isHomeRoute.value);

const websiteSchema = computed(() => JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: t('app.title'),
    description: t('app.description'),
    url: siteUrl.value,
    inLanguage: locale.value,
}));

const localeHead = useLocaleHead({ seo: true });

useHead(() => ({
    htmlAttrs: { ...localeHead.value.htmlAttrs },
    meta: [
        {
            name: 'viewport',
            content: 'width=device-width, initial-scale=1',
        },
        {
            name: 'theme-color',
            content: '#ffffff',
            media: '(prefers-color-scheme: light)',
        },
        {
            name: 'theme-color',
            content: '#1a1a1a',
            media: '(prefers-color-scheme: dark)',
        },
        ...localeHead.value.meta,
    ],
    link: [
        {
            rel: 'icon',
            type: 'image/png',
            sizes: '16x16',
            href: '/favicon-16x16.png?v=5',
        },
        {
            rel: 'icon',
            type: 'image/png',
            sizes: '32x32',
            href: '/favicon-32x32.png?v=5',
        },
        {
            rel: 'icon',
            type: 'image/svg+xml',
            href: '/favicon.svg?v=5',
        },
        {
            rel: 'icon',
            type: 'image/x-icon',
            href: '/favicon.ico?v=5',
        },
        {
            rel: 'apple-touch-icon',
            sizes: '180x180',
            href: '/apple-touch-icon.png',
        },
        {
            rel: 'preload',
            href: '/fonts/space-grotesk-latin.woff2',
            as: 'font',
            type: 'font/woff2',
            crossorigin: 'anonymous',
        },
        {
            rel: 'preload',
            href: '/fonts/space-grotesk-latin-ext.woff2',
            as: 'font',
            type: 'font/woff2',
            crossorigin: 'anonymous',
        },
        {
            rel: 'preload',
            href: '/fonts/ibm-plex-mono-400-latin.woff2',
            as: 'font',
            type: 'font/woff2',
            crossorigin: 'anonymous',
        },
        ...localeHead.value.link,
    ],
    script: [{
        key: 'website-schema',
        type: 'application/ld+json',
        textContent: websiteSchema.value,
    }],
}));

useSeoMeta({
    titleTemplate: chunk => chunk ? `${chunk} \u00b7 ${t('app.title')}` : t('app.title'),
    description: () => t('app.description'),
    robots: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    ogTitle: () => t('app.title'),
    ogDescription: () => t('app.description'),
    ogImage: () => ogImage.value,
    ogSiteName: () => t('app.title'),
    ogType: 'website',
    twitterTitle: () => t('app.title'),
    twitterDescription: () => t('app.description'),
    twitterImage: () => ogImage.value,
    twitterCard: 'summary_large_image',
});
</script>
