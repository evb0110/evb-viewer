<template>
  <footer class="site-footer section-reveal section-delay-3">
    <p>{{ t('footer.copyright') }}</p>

    <div class="footer-links">
      <UButton
        :label="t('footer.docs')"
        to="/docs"
        color="neutral"
        variant="ghost"
      />
      <UButton
        :label="t('footer.features')"
        to="/features"
        color="neutral"
        variant="ghost"
      />
      <UButton
        :label="t('footer.viewSource')"
        :to="repositoryUrl"
        target="_blank"
        color="neutral"
        variant="ghost"
        icon="i-simple-icons-github"
      />
    </div>
  </footer>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
</script>
