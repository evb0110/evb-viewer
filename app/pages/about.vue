<template>
    <main class="about-page">
        <article class="about-document" aria-labelledby="about-title">
            <header class="about-header">
                <p class="about-eyebrow">{{ t('about.eyebrow') }}</p>
                <h1 id="about-title">{{ t('about.title') }}</h1>
                <p class="about-version">{{ t('about.version', {version: appVersion}) }}</p>
            </header>

            <div class="about-content">
                <section class="about-section" aria-labelledby="about-acknowledgements-title">
                    <h2 id="about-acknowledgements-title">{{ t('about.acknowledgementsHeading') }}</h2>
                    <div class="about-sentry-card">
                        <img
                            class="about-sentry-wordmark"
                            :src="SENTRY_WORDMARK_PATH"
                            alt="Sentry"
                            width="200"
                            height="44"
                        >
                        <div class="about-sentry-copy">
                            <p>
                                {{ t('about.sentryAcknowledgement.message') }}
                                <a
                                    :href="SENTRY_OPEN_SOURCE_URL"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    @click="openExternalLink($event, SENTRY_OPEN_SOURCE_URL)"
                                >{{ t('about.sentryAcknowledgement.linkLabel') }}</a>.
                            </p>
                            <p>{{ t('about.sentryAcknowledgement.privacyNotice') }}</p>
                        </div>
                    </div>
                </section>

                <section class="about-section" aria-labelledby="about-legal-title">
                    <h2 id="about-legal-title">{{ t('about.legalHeading') }}</h2>
                    <ul class="about-links">
                        <li>
                            <a
                                :href="LICENSE_URL"
                                target="_blank"
                                rel="noopener noreferrer"
                                @click="openExternalLink($event, LICENSE_URL)"
                            >{{ t('about.licenseLinkLabel') }}</a>
                        </li>
                        <li>
                            <a
                                :href="THIRD_PARTY_NOTICES_URL"
                                target="_blank"
                                rel="noopener noreferrer"
                                @click="openExternalLink($event, THIRD_PARTY_NOTICES_URL)"
                            >{{ t('about.thirdPartyNoticesLinkLabel') }}</a>
                        </li>
                        <li>
                            <NuxtLink to="/privacy">{{ t('about.privacyPolicyLinkLabel') }}</NuxtLink>
                        </li>
                    </ul>
                </section>
            </div>

            <footer class="about-footer">
                <NuxtLink class="about-back-link" to="/">
                    <UIcon name="i-ph-arrow-left" aria-hidden="true" />
                    <span>{{ t('about.backToViewer') }}</span>
                </NuxtLink>
            </footer>
        </article>
    </main>
</template>

<script setup lang="ts">
import { getShellCapability } from '@app/utils/getShellCapability';

const SENTRY_OPEN_SOURCE_URL = 'https://sentry.io/for/open-source/';
const SENTRY_WORDMARK_PATH = '/sentry-wordmark.svg';
const LICENSE_URL = 'https://github.com/evb0110/evb-viewer/blob/main/LICENSE';
const THIRD_PARTY_NOTICES_URL = 'https://github.com/evb0110/evb-viewer/blob/main/THIRD_PARTY_NOTICES.md';
const appVersion = String(useRuntimeConfig().public.appVersion);

const { t } = useTypedI18n();
const { isDesktopRuntime } = useRuntimeEnvironment();

function openExternalLink(event: MouseEvent, url: string) {
    if (!isDesktopRuntime.value) {
        return;
    }

    event.preventDefault();
    void getShellCapability().openExternal(url).catch(() => undefined);
}

useHead(() => ({title: `${t('about.title')} | ${t('app.title')}`}));
</script>

<style scoped>
.about-page {
    min-height: 100dvh;
    padding: var(--app-privacy-page-padding) var(--app-privacy-inline-padding) var(--app-privacy-responsive-padding);
    background: var(--ui-bg);
    color: var(--ui-text);
}

.about-document {
    width: min(100%, 52rem);
    margin: 0 auto;
}

.about-header {
    padding-block-end: var(--app-privacy-footer-padding);
    border-block-end: 1px solid var(--ui-border);
}

.about-eyebrow,
.about-version {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body);
}

.about-eyebrow {
    margin: 0 0 var(--app-space-3xl);
    font-weight: 700;
}

.about-header h1 {
    margin: 0;
    font-size: var(--app-privacy-title-size);
    line-height: 1.1;
}

.about-version {
    margin: var(--app-space-3xl) 0 0;
}

.about-content {
    display: grid;
    gap: var(--app-space-12xl);
}

.about-section {
    padding-block-start: var(--app-privacy-section-margin);
}

.about-section + .about-section {
    border-block-start: 1px solid var(--ui-border);
}

.about-section h2 {
    margin: 0 0 var(--app-space-lg);
    font-size: var(--app-icon-size-lg);
}

.about-sentry-card {
    display: grid;
    grid-template-columns: minmax(9rem, 12.5rem) minmax(0, 1fr);
    gap: var(--app-space-12xl);
    align-items: center;
    padding: var(--app-space-15xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-surface);
    background: var(--ui-bg-elevated);
}

.about-sentry-wordmark {
    display: block;
    width: min(100%, 12.5rem);
    height: auto;
}

.about-sentry-copy,
.about-sentry-copy p {
    margin: 0;
}

.about-sentry-copy {
    display: grid;
    gap: var(--app-space-3xl);
    line-height: 1.7;
}

.about-links {
    display: grid;
    gap: var(--app-space-md);
    margin: 0;
    padding: 0;
    list-style: none;
}

.about-page a {
    color: var(--ui-primary);
    text-decoration: underline;
    text-underline-offset: var(--app-space-xs);
}

.about-page a:hover {
    color: var(--ui-primary-hover);
}

.about-page a:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 3px;
    border-radius: var(--app-radius-xs);
}

.about-footer {
    display: flex;
    justify-content: flex-start;
    margin-block-start: var(--app-space-12xl);
}

.about-back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.about-back-link :deep(svg) {
    flex: 0 0 auto;
}

@media (width >= 48rem) {
    .about-page {
        padding-block-start: var(--app-privacy-responsive-padding);
    }

    .about-header h1 {
        font-size: var(--app-privacy-title-size-wide);
    }
}

@media (width <= 40rem) {
    .about-page {
        padding-block: var(--app-space-12xl) var(--app-space-15xl);
    }

    .about-sentry-card {
        grid-template-columns: minmax(0, 1fr);
        gap: var(--app-space-8xl);
    }
}
</style>
