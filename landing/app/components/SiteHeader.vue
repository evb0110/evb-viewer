<template>
  <header class="site-header section-reveal">
    <NuxtLink
      class="brand-link"
      to="/"
    >
      <span class="brand-mark">EVB</span>
      <span class="brand-name">Viewer</span>
    </NuxtLink>

    <nav class="header-nav">
      <UButton
        v-for="item in navItems"
        :key="item.to"
        :label="item.label"
        :to="item.to"
        color="neutral"
        :variant="isActive(item.to) ? 'soft' : 'ghost'"
      />
    </nav>

    <div class="header-actions">
      <UButton
        :to="repositoryUrl"
        target="_blank"
        icon="i-simple-icons-github"
        color="neutral"
        variant="ghost"
      />

      <LanguageSwitcher />
    </div>
  </header>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();
const route = useRoute();
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';

const navItems = computed(() => [
    {
        label: t('header.nav.home'),
        to: '/',
    },
    {
        label: t('header.nav.features'),
        to: '/features',
    },
    {
        label: t('header.nav.docs'),
        to: '/docs',
    },
]);

function isActive(path: string) {
    return route.path === path;
}
</script>
