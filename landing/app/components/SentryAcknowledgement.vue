<template>
  <div class="sentry-acknowledgement">
    <a
      class="sentry-wordmark-link"
      href="https://sentry.io/for/open-source/"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="t('footer.sentryAcknowledgement.linkLabel')"
    >
      <img
        class="sentry-wordmark"
        :src="SENTRY_WORDMARK_PATH"
        alt="Sentry"
        width="200"
        height="44"
        loading="lazy"
        decoding="async"
      />
    </a>

    <p class="sentry-acknowledgement-copy">
      {{ t('footer.sentryAcknowledgement.message') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import {useTypedI18n} from '../composables/useTypedI18n';

const SENTRY_WORDMARK_PATH = '/sentry-wordmark.svg';
const {t} = useTypedI18n();
</script>

<style scoped>
.sentry-acknowledgement {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
  color: var(--landing-muted);
}

/* The wordmark carries the open-source-program link, so the credit holds one
   line instead of trailing a second link that wrapped on its own. */
.sentry-wordmark-link {
  display: block;
  flex: 0 0 auto;
  border-radius: 0.3rem;
}

.sentry-wordmark-link:hover .sentry-wordmark {
  opacity: 0.72;
}

.sentry-wordmark-link:focus-visible {
  outline: 0.15rem solid var(--landing-accent);
  outline-offset: 0.2rem;
}

.sentry-wordmark {
  display: block;
  width: 5.5rem;
  max-width: min(34vw, 5.5rem);
  height: auto;
  transition: opacity 0.15s;
}

/* The wordmark loads through <img>, so currentColor resolves to black inside
   its own document and the dark theme cannot tint it. The asset stays
   untouched; the dark theme puts it on its own light plate instead. */
html.dark .sentry-wordmark {
  box-sizing: content-box;
  padding: 0.3rem 0.4rem;
  border-radius: 0.4rem;
  background: #fff;
}

.sentry-acknowledgement-copy {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.45;
  text-wrap: balance;
}

@media (width <= 40rem) {
  .sentry-acknowledgement {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.5rem;
  }
}
</style>
