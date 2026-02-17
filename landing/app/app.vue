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
const { t } = useTypedI18n();
const { locale } = useI18n();

const ogImage = 'https://raw.githubusercontent.com/evb0110/evb-viewer/main/docs/screenshot.png';

useHead(() => ({
    htmlAttrs: { lang: locale.value },
    meta: [{
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
    }],
    link: [{
        rel: 'icon',
        href: '/favicon.ico',
    }],
}));

useSeoMeta({
    titleTemplate: chunk => chunk ? `${chunk} \u00b7 ${t('app.title')}` : t('app.title'),
    description: () => t('app.description'),
    ogTitle: () => t('app.title'),
    ogDescription: () => t('app.description'),
    ogImage,
    twitterTitle: () => t('app.title'),
    twitterDescription: () => t('app.description'),
    twitterImage: ogImage,
    twitterCard: 'summary_large_image',
});
</script>
