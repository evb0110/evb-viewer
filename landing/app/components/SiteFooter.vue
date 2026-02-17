<script setup lang="ts">
const repositoryUrl = 'https://github.com/evb0110/electron-nuxt';
</script>

<template>
  <footer class="site-footer section-reveal section-delay-3">
    <p>Copyright © 2026 Eugene Barsky</p>

    <div class="footer-links">
      <UButton
        label="Documentation"
        to="/docs"
        color="neutral"
        variant="ghost"
      />
      <UButton
        label="Features"
        to="/features"
        color="neutral"
        variant="ghost"
      />
      <UButton
        label="View source"
        :to="repositoryUrl"
        target="_blank"
        color="neutral"
        variant="ghost"
        icon="i-simple-icons-github"
      />
    </div>
  </footer>
</template>
