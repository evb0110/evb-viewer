<script setup lang="ts">
const route = useRoute();
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';

const navItems = [
    {
        label: 'Home',
        to: '/',
    },
    {
        label: 'Features',
        to: '/features',
    },
    {
        label: 'Documentation',
        to: '/docs',
    },
];

function isActive(path: string): boolean {
    return route.path === path;
}
</script>

<template>
  <header class="site-header section-reveal">
    <NuxtLink
      class="brand-link"
      to="/"
    >
      <span class="brand-mark">EVB</span>
      <span class="brand-name">Viewer</span>
    </NuxtLink>

    <div class="header-actions">
      <UButton
        v-for="item in navItems"
        :key="item.to"
        :label="item.label"
        :to="item.to"
        color="neutral"
        :variant="isActive(item.to) ? 'soft' : 'ghost'"
      />

      <UButton
        label="GitHub"
        :to="repositoryUrl"
        target="_blank"
        icon="i-simple-icons-github"
        color="primary"
        variant="soft"
      />
    </div>
  </header>
</template>
