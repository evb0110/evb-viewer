<template>
  <footer class="site-footer">
    <SentryAcknowledgement />

    <div class="footer-copy">
      <p class="footer-title">{{ t('app.title') }}</p>
      <p class="footer-meta">{{ t('footer.copyright') }}</p>
    </div>

    <div class="footer-links">
      <UButton
        :label="t('footer.privacy')"
        :to="localePath('/privacy')"
        color="neutral"
        variant="ghost"
      />
      <UButton
        :label="t('footer.viewSource')"
        :to="GITHUB_REPOSITORY_URL"
        target="_blank"
        color="neutral"
        variant="ghost"
        icon="i-simple-icons-github"
      />
    </div>
  </footer>
</template>

<script setup lang="ts">
import { GITHUB_REPOSITORY_URL } from '~/constants/githubRepositoryUrl';
import SentryAcknowledgement from './SentryAcknowledgement.vue';

const { t } = useTypedI18n();
const localePath = useLocalePath();
</script>
