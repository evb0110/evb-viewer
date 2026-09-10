<template>
    <main class="privacy-page">
        <article class="privacy-document">
            <header>
                <p class="privacy-brand">EVB Viewer</p>
                <h1>{{ privacyCopy.hero.title }}</h1>
                <p class="privacy-summary">
                    {{ privacyCopy.hero.subtitle }}
                </p>
                <p class="privacy-effective-date">{{ privacyCopy.hero.effectiveDate }}</p>
            </header>

            <section>
                <h2>{{ privacyCopy.documents.heading }}</h2>
                <p>{{ privacyCopy.documents.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.assistant.heading }}</h2>
                <p>{{ privacyCopy.assistant.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.diagnostics.heading }}</h2>
                <p>{{ privacyCopy.diagnostics.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.analytics.heading }}</h2>
                <p>{{ privacyCopy.analytics.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.settings.heading }}</h2>
                <p>{{ privacyCopy.settings.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.storage.heading }}</h2>
                <p>{{ privacyCopy.storage.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.retention.heading }}</h2>
                <p>{{ privacyCopy.retention.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.contact.heading }}</h2>
                <p>{{ privacyCopy.contact.body }}</p>
            </section>
        </article>
    </main>
</template>

<script setup lang="ts">
import { PRIVACY_MESSAGES } from '@i18n-core';

const { locale } = useTypedI18n();
const privacyCopy = computed(() => PRIVACY_MESSAGES[locale.value]);

useHead(() => ({
    title: `${privacyCopy.value.seo.title} | EVB Viewer`,
    meta: [{
        name: 'description',
        content: privacyCopy.value.seo.description,
    }],
    link: [{
        rel: 'canonical',
        href: 'https://web.evb-viewer.com/privacy',
    }],
}));
</script>

<style scoped>
.privacy-page {
    min-height: 100dvh;
    padding: var(--app-privacy-page-padding) var(--app-privacy-inline-padding) var(--app-privacy-responsive-padding);
    background: var(--ui-bg);
    color: var(--ui-text);
}

.privacy-document {
    width: min(100%, var(--app-privacy-document-max-width));
    margin: 0 auto;
}

.privacy-document header {
    padding-bottom: var(--app-privacy-footer-padding);
    border-bottom: 1px solid var(--ui-border);
}

.privacy-brand,
.privacy-effective-date {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body);
}

.privacy-brand {
    margin: 0 0 var(--app-space-3xl);
    font-weight: 700;
}

.privacy-document h1 {
    margin: 0;
    font-size: var(--app-privacy-title-size);
    line-height: 1.1;
}

.privacy-summary {
    max-width: var(--app-privacy-measure);
    margin: var(--app-space-6xl) 0 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-title-md);
    line-height: 1.6;
}

.privacy-effective-date {
    margin: var(--app-space-6xl) 0 0;
}

.privacy-document section {
    padding-top: var(--app-privacy-section-margin);
}

.privacy-document h2 {
    margin: 0 0 var(--app-space-lg);
    font-size: var(--app-icon-size-lg);
}

.privacy-document p {
    margin: 0;
    line-height: 1.75;
}

.privacy-document a {
    color: var(--ui-primary);
    text-decoration: underline;
    text-underline-offset: var(--app-space-xs);
}

@media (width >= 48rem) {
    .privacy-page {
        padding-top: var(--app-privacy-responsive-padding);
    }

    .privacy-document h1 {
        font-size: var(--app-privacy-title-size-wide);
    }
}
</style>
