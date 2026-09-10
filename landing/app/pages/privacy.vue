<template>
  <main aria-labelledby="privacy-title">
    <section class="page-intro">
      <h1
        id="privacy-title"
        class="page-title"
      >
        {{ privacy.hero.title }}
      </h1>
      <p class="page-subtitle">
        {{ privacy.hero.subtitle }}
      </p>
      <p class="privacy-effective-date">
        {{ privacy.hero.effectiveDate }}
      </p>
    </section>

    <section class="content-section privacy-content">
      <div>
        <h2>{{ privacy.documents.heading }}</h2>
        <p>{{ privacy.documents.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.assistant.heading }}</h2>
        <p>{{ privacy.assistant.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.diagnostics.heading }}</h2>
        <p>{{ privacy.diagnostics.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.analytics.heading }}</h2>
        <p>{{ privacy.analytics.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.settings.heading }}</h2>
        <p>{{ privacy.settings.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.storage.heading }}</h2>
        <p>{{ privacy.storage.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.retention.heading }}</h2>
        <p>{{ privacy.retention.body }}</p>
      </div>

      <div>
        <h2>{{ privacy.contact.heading }}</h2>
        <p>{{ privacy.contact.body }}</p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { PRIVACY_MESSAGES } from '@i18n-core';

const { locale } = useTypedI18n();
const privacy = computed(() => PRIVACY_MESSAGES[locale.value]);

useLandingPageSeo({
    title: () => privacy.value.seo.title,
    description: () => privacy.value.seo.description,
});
</script>

<style scoped>
.privacy-effective-date {
  color: var(--landing-muted);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.privacy-content {
  display: grid;
  gap: 2rem;
  max-width: 54rem;
}

.privacy-content h2 {
  margin-bottom: 0.6rem;
  color: var(--landing-ink);
  font-size: 1.15rem;
}

.privacy-content p {
  margin: 0;
  color: var(--landing-ink-soft);
  line-height: 1.75;
}

.privacy-content a {
  color: var(--landing-accent);
  text-decoration: underline;
  text-underline-offset: 0.18rem;
}
</style>
