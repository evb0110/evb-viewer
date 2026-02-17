<script setup lang="ts">
const title = 'EVB Viewer';
const description = 'Cross-platform desktop viewer for PDF and DjVu documents with OCR, annotations, and export tools.';
const ogImage = 'https://raw.githubusercontent.com/evb0110/electron-nuxt/main/docs/screenshot.png';

useHead({
    htmlAttrs: {lang: 'en'},
    meta: [{
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
    }],
    link: [{
        rel: 'icon',
        href: '/favicon.ico',
    }],
});

useSeoMeta({
    titleTemplate: chunk => chunk ? `${chunk} · EVB Viewer` : 'EVB Viewer',
    description,
    ogTitle: title,
    ogDescription: description,
    ogImage,
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: ogImage,
    twitterCard: 'summary_large_image',
});
</script>

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
