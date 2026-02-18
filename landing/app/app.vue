<template>
  <UApp>
    <div class="landing-root">
      <div class="landing-ambient landing-ambient-left" />
      <div class="landing-ambient landing-ambient-right" />

      <UContainer class="landing-container">
        <SiteHeader />
        <NuxtPage />
        <SiteFooter />
      </UContainer>
    </div>
  </UApp>
</template>

<script setup lang="ts">
import {
    buildAbsoluteUrl,
    normalizeSiteUrl,
} from '~~/shared/seo';

const { t } = useTypedI18n();
const { locale } = useI18n();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();

const OPEN_GRAPH_LOCALE_BY_LOCALE = {
    en: 'en_US',
    ru: 'ru_RU',
    fr: 'fr_FR',
    de: 'de_DE',
    es: 'es_ES',
    it: 'it_IT',
    pt: 'pt_PT',
    nl: 'nl_NL',
} as const;

const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
const canonicalUrl = computed(() => buildAbsoluteUrl(siteUrl.value, route.path));
const ogImage = computed(() => buildAbsoluteUrl(siteUrl.value, '/evb-viewer-preview.png'));
const ogLocale = computed(
    () => OPEN_GRAPH_LOCALE_BY_LOCALE[locale.value as keyof typeof OPEN_GRAPH_LOCALE_BY_LOCALE]
        || OPEN_GRAPH_LOCALE_BY_LOCALE.en,
);
const ogLocaleAlternates = computed(
    () => Object.entries(OPEN_GRAPH_LOCALE_BY_LOCALE)
        .filter(([code]) => code !== locale.value)
        .map(([
            ,
            ogLocaleValue,
        ]) => ogLocaleValue),
);

const websiteSchema = computed(() => JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: t('app.title'),
    description: t('app.description'),
    url: siteUrl.value,
    inLanguage: locale.value,
}));

useHead(() => ({
    htmlAttrs: { lang: locale.value },
    meta: [
        {
            name: 'viewport',
            content: 'width=device-width, initial-scale=1',
        },
        ...ogLocaleAlternates.value.map(ogLocaleValue => ({
            property: 'og:locale:alternate',
            content: ogLocaleValue,
        })),
    ],
    link: [
        {
            rel: 'icon',
            href: '/favicon.ico',
        },
        {
            rel: 'canonical',
            href: canonicalUrl.value,
        },
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
    ogUrl: () => canonicalUrl.value,
    ogSiteName: () => t('app.title'),
    ogType: 'website',
    ogLocale: () => ogLocale.value,
    twitterTitle: () => t('app.title'),
    twitterDescription: () => t('app.description'),
    twitterImage: () => ogImage.value,
    twitterCard: 'summary_large_image',
});
</script>
