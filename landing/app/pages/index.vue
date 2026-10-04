<template>
  <div class="home-page">
    <header class="home-topbar">
      <div class="home-brand">
        <NuxtLink
          class="brand-link"
          :to="localePath('/')"
        >
          <span class="brand-mark">EVB</span>
          <span class="brand-name">Viewer</span>
        </NuxtLink>

        <span
          v-if="releaseData"
          class="home-version"
        >
          {{ releaseData.release.tag }}
        </span>
      </div>

      <div class="home-actions">
        <UButton
          v-if="webAppUrl"
          :label="t('home.hero.openInBrowser')"
          :aria-label="t('home.hero.openInBrowser')"
          :to="webAppUrl"
          target="_blank"
          rel="noreferrer"
          color="neutral"
          variant="ghost"
          size="md"
          icon="i-ph-globe"
          :ui="{ label: 'max-sm:hidden' }"
        />

        <UColorModeButton
          color="neutral"
          variant="ghost"
        />

        <LanguageSwitcher />

        <UButton
          :to="GITHUB_REPOSITORY_URL"
          target="_blank"
          rel="noreferrer"
          color="neutral"
          variant="ghost"
          size="md"
          icon="i-simple-icons-github"
          square
          :aria-label="t('footer.viewSource')"
        />
      </div>
    </header>

    <main
      class="home-body"
      aria-labelledby="home-title"
    >
      <section class="home-hero">
        <div class="home-hero-intro">
          <h1
            id="home-title"
            class="home-title"
          >
            {{ t('home.hero.title') }}
          </h1>

          <p class="home-lede">
            {{ t('home.hero.lede') }}
          </p>
        </div>

        <div class="home-hero-film">
          <FilmPlayer
            :locale="locale"
            :theme="filmTheme"
            title="EVB Viewer"
            :label="t('home.film.ariaLabel')"
            :play-label="t('home.film.play')"
            :pause-label="t('home.film.pause')"
            :position-label="t('home.film.position')"
          />
          <p class="home-film-caption">
            {{ t('home.film.caption') }}
          </p>
        </div>

        <div
          id="installers"
          class="home-hero-get installer-card installer-card-compact"
        >
          <div
            v-if="status === 'pending' || status === 'idle'"
            class="installer-state"
          >
            <p>{{ t('home.installers.loading') }}</p>
          </div>

          <div
            v-else-if="error"
            class="installer-state"
          >
            <p>{{ t('home.installers.error') }}</p>
            <UButton
              :label="t('home.installers.retry')"
              color="neutral"
              variant="outline"
              @click="refreshReleaseData"
            />
          </div>

          <div
            v-else-if="installersForSelectedPlatform.length"
            class="installer-content"
          >
            <div class="installer-platforms">
              <UButton
                v-for="tab in installerTabs"
                :key="tab"
                :label="installerPlatformLabel(tab)"
                size="sm"
                color="neutral"
                :variant="selectedInstallerTab === tab ? 'solid' : 'ghost'"
                class="installer-platform-button"
                @click="selectInstallerTab(tab)"
              />
            </div>

            <div
              class="installer-list"
              :class="{ 'installer-list-mirrored': hasMirrorForSelectedPlatform }"
            >
              <div
                v-for="installer in installersForSelectedPlatform"
                :key="installer.id"
                class="installer-row"
                :class="{ 'installer-row-recommended': isRecommendedInstaller(installer) }"
              >
                <a
                  class="installer-item"
                  :class="{ 'installer-item-recommended': isRecommendedInstaller(installer) }"
                  :href="installer.downloadUrl"
                  :aria-label="downloadAriaLabel(installer)"
                  @click="trackInstallerDownload(installer, 'github')"
                >
                  <div class="installer-item-info">
                    <div class="installer-item-header">
                      <span class="installer-item-variant">{{ installerLabel(installer) }}</span>
                      <span
                        v-if="isRecommendedInstaller(installer)"
                        class="installer-badge"
                      >
                        {{ t('home.installers.recommended') }}
                      </span>
                    </div>
                    <span class="installer-item-detail">
                      {{ installerDetail(installer) }}
                    </span>
                    <span class="installer-item-meta">
                      {{ installerMeta(installer) }}
                    </span>
                  </div>
                  <span class="installer-item-chip">
                    <UIcon
                      name="i-ph-download"
                      class="installer-item-icon"
                    />
                  </span>
                </a>
                <template v-if="hasMirrorForSelectedPlatform">
                  <a
                    v-if="installer.mirrorDownloadUrl"
                    class="installer-mirror-cell installer-mirror-link"
                    :href="installer.mirrorDownloadUrl"
                    :aria-label="mirrorDownloadAriaLabel(installer)"
                    @click="trackInstallerDownload(installer, 'mirror')"
                  >
                    {{ t('home.installers.mirror') }}
                  </a>
                  <span
                    v-else
                    class="installer-mirror-cell"
                    aria-hidden="true"
                  />
                </template>
              </div>

              <div
                v-if="selectedInstallerTab === 'windows'"
                class="installer-row"
              >
                <a
                  class="installer-item installer-item-store"
                  :href="MICROSOFT_STORE_URL"
                  target="_blank"
                  rel="noreferrer"
                  :aria-label="t('home.installers.store.ariaLabel')"
                >
                  <div class="installer-item-info">
                    <div class="installer-item-header">
                      <span class="installer-item-variant">{{ t('home.installers.store.title') }}</span>
                    </div>
                    <span class="installer-item-detail">
                      {{ t('home.installers.store.detail') }}
                    </span>
                    <span class="installer-item-meta">
                      {{ t('home.installers.store.meta') }}
                    </span>
                  </div>
                  <span class="installer-item-chip">
                    <UIcon
                      name="i-simple-icons-microsoft"
                      class="installer-item-icon"
                    />
                  </span>
                </a>
                <span
                  v-if="hasMirrorForSelectedPlatform"
                  class="installer-mirror-cell"
                  aria-hidden="true"
                />
              </div>
            </div>

            <p class="installer-hint">
              {{ installerPlatformHint }}
            </p>

          </div>

          <div
            v-else
            class="installer-state"
          >
            <p>{{ t('home.installers.noArtifacts') }}</p>
          </div>

          <NuxtLink
            class="installer-browse"
            :to="fallbackReleaseUrl"
            target="_blank"
            rel="noreferrer"
          >
            {{ t('home.hero.browseInstallers') }}
            <UIcon
              name="i-ph-arrow-right"
              class="installer-browse-icon"
            />
          </NuxtLink>
        </div>
      </section>

      <section
        class="home-section"
        aria-labelledby="features-title"
      >
        <h2
          id="features-title"
          class="home-kicker"
        >
          {{ t('home.features.title') }}
        </h2>
        <div class="home-grid">
          <article
            v-for="feature in features"
            :key="feature.key"
            class="home-card"
          >
            <UIcon
              class="home-card-icon"
              :name="feature.icon"
            />
            <h3>{{ feature.title }}</h3>
            <p>{{ feature.text }}</p>
          </article>
        </div>
      </section>

      <section
        class="home-section"
        aria-labelledby="audience-title"
      >
        <h2
          id="audience-title"
          class="home-kicker"
        >
          {{ t('home.audience.title') }}
        </h2>
        <div class="home-grid home-grid-four">
          <article
            v-for="audience in audiences"
            :key="audience.key"
            class="home-card"
          >
            <UIcon
              class="home-card-icon"
              :name="audience.icon"
            />
            <h3>{{ audience.title }}</h3>
            <p>{{ audience.text }}</p>
          </article>
        </div>
      </section>

      <section
        class="home-section"
        aria-labelledby="faq-title"
      >
        <h2
          id="faq-title"
          class="home-kicker"
        >
          {{ t('home.faq.title') }}
        </h2>
        <div class="home-faq">
          <article
            v-for="item in faq"
            :key="item.key"
            class="home-faq-item"
          >
            <h3>{{ item.question }}</h3>
            <p>{{ item.answer }}</p>
          </article>
        </div>
      </section>
    </main>

    <footer class="home-bottom">
      <span class="home-copyright"><SiteCopyright /> · {{ t('footer.license') }}</span>
      <nav
        class="home-links"
        :aria-label="t('footer.linksLabel')"
      >
        <NuxtLink :to="localePath('/features')">{{ t('footer.features') }}</NuxtLink>
        <NuxtLink :to="localePath('/docs')">{{ t('footer.docs') }}</NuxtLink>
        <NuxtLink :to="localePath('/privacy')">{{ t('footer.privacy') }}</NuxtLink>
        <a
          :href="GITHUB_REPOSITORY_URL"
          target="_blank"
          rel="noreferrer"
        >{{ t('footer.viewSource') }}</a>
      </nav>
      <SentryAcknowledgement class="home-footer-acknowledgement" />
    </footer>
  </div>
</template>

<script setup lang="ts">
import { track } from '@vercel/analytics';
import { GITHUB_REPOSITORY_URL } from '~/constants/githubRepositoryUrl';
import { selectInstallersForPlatform } from '~~/shared/selectInstallersForPlatform';
import SentryAcknowledgement from '~/components/SentryAcknowledgement.vue';
import SiteCopyright from '~/components/SiteCopyright.vue';
import {
    buildClientProfile,
    formatFileSize,
    formatPlatform,
    INSTALLER_PLATFORM_ORDER,
    parseArchitectureHint,
    parsePlatformHint,
    recommendInstaller,
    type IReleaseInstaller,
    type TReleaseArch,
    type IUserAgentProfile,
    type TReleasePlatform,
} from '@releaseSelection';

interface INavigatorUADataLike {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const {
    t,
    locale,
} = useTypedI18n();
const localePath = useLocalePath();
const runtimeConfig = useRuntimeConfig();
const colorMode = useColorMode();
const webAppUrl = computed(() => runtimeConfig.public.webAppUrl.trim() || '');
// The film mounts on the client, after color mode has resolved the system preference.
const filmTheme = computed(() => colorMode.value === 'dark' ? 'dark' : 'light');

const FEATURE_ICONS = [
    {
        key: 'cleanup',
        icon: 'i-ph-broom',
    },
    {
        key: 'ocr',
        icon: 'i-ph-text-t',
    },
    {
        key: 'search',
        icon: 'i-ph-magnifying-glass',
    },
    {
        key: 'annotate',
        icon: 'i-ph-highlighter',
    },
    {
        key: 'pages',
        icon: 'i-ph-files',
    },
    {
        key: 'export',
        icon: 'i-ph-export',
    },
] as const;
const AUDIENCE_ICONS = [
    {
        key: 'archives',
        icon: 'i-ph-archive',
    },
    {
        key: 'scholars',
        icon: 'i-ph-scroll',
    },
    {
        key: 'students',
        icon: 'i-ph-student',
    },
    {
        key: 'personal',
        icon: 'i-ph-books',
    },
] as const;
const FAQ_KEYS = [
    'free',
    'files',
    'languages',
    'formats',
    'browser',
    'assistant',
] as const;

const features = computed(() => FEATURE_ICONS.map(({
    key,
    icon,
}) => ({
    key,
    icon,
    title: t(`home.features.items.${key}.title`),
    text: t(`home.features.items.${key}.text`),
})));
const audiences = computed(() => AUDIENCE_ICONS.map(({
    key,
    icon,
}) => ({
    key,
    icon,
    title: t(`home.audience.items.${key}.title`),
    text: t(`home.audience.items.${key}.text`),
})));
const faq = computed(() => FAQ_KEYS.map(key => ({
    key,
    question: t(`home.faq.items.${key}.question`),
    answer: t(`home.faq.items.${key}.answer`, {webAppUrl: webAppUrl.value.replace(/^https?:\/\//u, '')}),
})));

const MICROSOFT_STORE_URL = 'https://apps.microsoft.com/detail/9N3MB1WJGX1L';

const pageDescription = computed(() => t('home.seo.ogDescription'));

const {
    canonicalUrl,
    ogImage,
} = useLandingPageSeo({
    title: () => t('home.seo.title'),
    description: () => pageDescription.value,
    ogTitle: () => t('home.seo.ogTitle'),
});

const clientProfile = useState<IUserAgentProfile>('landing-client-profile', () => {
    return {
        platform: 'unknown',
        arch: 'unknown',
    };
});

const {
    data: releaseData,
    error,
    refresh,
    status,
} = await useFetch('/api/releases/latest', {
    key: 'latest-release-data',
    server: false,
});

const installers = computed(() => releaseData.value?.assets ?? []);

const selectablePlatforms = computed<TReleasePlatform[]>(() => INSTALLER_PLATFORM_ORDER.filter(
    platform => installers.value.some(asset => asset.platform === platform),
));

const installerTabs = computed<TReleasePlatform[]>(() => selectablePlatforms.value);

const recommendedInstaller = computed<IReleaseInstaller | null>(() => {
    if (!installers.value.length || clientProfile.value.platform === 'unknown') {
        return null;
    }

    return recommendInstaller(installers.value, clientProfile.value);
});

const selectedInstallerTabOverride = ref<TReleasePlatform | null>(null);

const selectedInstallerTab = computed<TReleasePlatform>(() => {
    if (selectedInstallerTabOverride.value && installerTabs.value.includes(selectedInstallerTabOverride.value)) {
        return selectedInstallerTabOverride.value;
    }

    const recPlatform = recommendedInstaller.value?.platform ?? 'unknown';
    if (selectablePlatforms.value.includes(recPlatform)) {
        return recPlatform;
    }

    return selectablePlatforms.value[0] ?? 'unknown';
});

const installersForSelectedPlatform = computed(() => selectInstallersForPlatform(installers.value, selectedInstallerTab.value));

// The mirror column is reserved for the whole list so every download chip lands
// in the same place. Platforms whose assets are all absent from the mirror drop
// the column instead of showing an empty strip.
const hasMirrorForSelectedPlatform = computed(() => installersForSelectedPlatform.value
    .some(installer => Boolean(installer.mirrorDownloadUrl)));

const installerPlatformHint = computed(() => {
    if (selectedInstallerTab.value === 'macos') {
        return t('home.installers.platformHint.macos');
    }

    if (selectedInstallerTab.value === 'windows') {
        return t('home.installers.platformHint.windows');
    }

    if (selectedInstallerTab.value === 'linux') {
        return t('home.installers.platformHint.linux');
    }

    return t('home.installers.platformHint.default');
});

const fallbackReleaseUrl = computed(() => releaseData.value?.release.htmlUrl ?? `${GITHUB_REPOSITORY_URL}/releases`);
const softwareApplicationSchema = computed(() => {
    const latestRelease = releaseData.value?.release;

    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: t('app.title'),
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web, macOS, Windows, Linux',
        description: pageDescription.value,
        url: canonicalUrl.value,
        image: ogImage.value,
        downloadUrl: fallbackReleaseUrl.value,
        author: {
            '@type': 'Person',
            name: 'Eugene Barsky',
        },
        offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
        },
        softwareVersion: latestRelease?.tag,
        datePublished: latestRelease?.publishedAt,
    };
});

useHead(() => ({ script: [{
    key: 'software-application-schema',
    type: 'application/ld+json',
    textContent: JSON.stringify(softwareApplicationSchema.value),
}] }));

onMounted(async () => {
    clientProfile.value = await detectClientProfile();
});

async function detectClientProfile(): Promise<IUserAgentProfile> {
    const uaData = (navigator as Navigator & { userAgentData?: INavigatorUADataLike }).userAgentData;

    if (!uaData) {
        return buildClientProfile(navigator.userAgent);
    }

    const hintedPlatform = parsePlatformHint(uaData.platform);
    let hintedArch: TReleaseArch = 'unknown';

    if (typeof uaData.getHighEntropyValues === 'function') {
        try {
            const entropyValues = await uaData.getHighEntropyValues(['architecture']);
            hintedArch = parseArchitectureHint(entropyValues.architecture);
        } catch {
            hintedArch = 'unknown';
        }
    }

    return buildClientProfile(navigator.userAgent, hintedPlatform, hintedArch);
}

function trackInstallerDownload(installer: IReleaseInstaller, source: 'github' | 'mirror') {
    track('download', {
        platform: installer.platform,
        arch: installer.arch,
        version: releaseData.value?.release.tag ?? 'unknown',
        source,
    });
}

function isRecommendedInstaller(installer: IReleaseInstaller) {
    return recommendedInstaller.value?.id === installer.id;
}

function selectInstallerTab(tab: TReleasePlatform) {
    selectedInstallerTabOverride.value = tab;
}

function installerPlatformLabel(platform: TReleasePlatform): string {
    if (platform === 'macos') {
        return t('features.platforms.macOs');
    }

    if (platform === 'windows') {
        return t('features.platforms.windows');
    }

    if (platform === 'linux') {
        return t('features.platforms.linux');
    }

    return formatPlatform(platform);
}

function installerLabel(installer: IReleaseInstaller): string {
    const arch = installer.arch;

    if (installer.platform === 'macos' && arch === 'arm64') {
        return t('home.installers.arch.appleSilicon');
    }

    if (arch === 'x64') {
        return t('home.installers.arch.x64');
    }

    if (arch === 'arm64') {
        return t('home.installers.arch.arm64');
    }

    if (arch === 'universal') {
        return t('home.installers.arch.universal');
    }

    return packageLabel(installer);
}

function packageLabel(installer: IReleaseInstaller): string {
    if (installer.extension === 'deb') {
        return t('home.installers.package.deb');
    }

    if (installer.extension === 'dmg') {
        return t('home.installers.package.dmg');
    }

    if (installer.extension === 'exe') {
        return t('home.installers.package.exe');
    }

    return installer.extension.toUpperCase();
}

function installerDetail(installer: IReleaseInstaller): string {
    if (installer.platform === 'linux' && installer.extension === 'deb') {
        return t('home.installers.detail.linuxDeb');
    }

    if (installer.platform === 'macos' && installer.arch === 'arm64') {
        return t('home.installers.detail.macosArm64');
    }

    if (installer.platform === 'windows' && installer.arch === 'arm64') {
        return t('home.installers.detail.windowsArm64');
    }

    if (installer.platform === 'windows' && installer.arch === 'x64') {
        return t('home.installers.detail.windowsX64');
    }

    return packageLabel(installer);
}

function installerMeta(installer: IReleaseInstaller): string {
    return t('home.installers.packageSize', {
        package: packageLabel(installer),
        size: formatFileSize(installer.size),
    });
}

function downloadAriaLabel(installer: IReleaseInstaller): string {
    return t('home.hero.downloadInstaller', {installerLabel: `${installerLabel(installer)} ${packageLabel(installer)}`});
}

function mirrorDownloadAriaLabel(installer: IReleaseInstaller): string {
    return `${t('home.installers.mirror')}: ${downloadAriaLabel(installer)}`;
}

async function refreshReleaseData() {
    await refresh();
}
</script>

<style scoped>
.home-page {
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - 2 * clamp(1rem, 2vw, 1.5rem));
}

.home-body {
  flex: 1;
  padding-bottom: clamp(2.5rem, 5vw, 4rem);
}

/* The film sits beside the copy on wide screens, so the whole recording is visible without scrolling.
   Its height is about 0.67 of its width plus the controls; the column stops growing before the fold. */
.home-hero {
  display: grid;
  grid-template-areas:
    "intro film"
    "get film";
  grid-template-rows: auto 1fr;
  grid-template-columns: minmax(18rem, 26rem) minmax(0, calc((100vh - 11rem) * 1.45));
  gap: 1.75rem clamp(2rem, 4vw, 3.5rem);
  justify-content: center;
  padding: clamp(1.75rem, 3.5vw, 2.75rem) 0 clamp(2.5rem, 5vw, 4rem);
}

.home-hero-intro {
  grid-area: intro;
}

.home-hero-film {
  grid-area: film;
  min-width: 0;
}

.home-hero-get {
  grid-area: get;
}

.home-title {
  margin: 0;
  font-size: clamp(2.25rem, 3.6vw, 3.25rem);
  line-height: 1.02;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.home-lede {
  margin: 1.125rem 0 0;
  color: var(--landing-ink-soft);
  font-size: 1.0625rem;
  line-height: 1.55;
}

.home-film-caption {
  margin: 0.625rem 0 0;
  color: var(--landing-muted);
  font-size: 0.8125rem;
  text-align: center;
}

.home-section {
  padding: clamp(2.5rem, 5vw, 4rem) 0 0;
  text-align: center;
}

.home-kicker {
  margin: 0;
  color: var(--landing-muted);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.home-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-top: 1.875rem;
  overflow: hidden;
  border: 1px solid var(--landing-border);
  border-radius: 1rem;
  background: var(--landing-border);
  text-align: left;
}

.home-grid-four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.home-card {
  padding: 1.75rem 1.625rem 1.875rem;
  background: var(--landing-surface);
}

.home-card-icon {
  width: 1.375rem;
  height: 1.375rem;
  color: var(--landing-accent);
}

.home-card h3 {
  margin: 1rem 0 0;
  font-size: 1.0625rem;
  font-weight: 650;
}

.home-card p {
  margin: 0.5rem 0 0;
  color: var(--landing-ink-soft);
  font-size: 0.9375rem;
  line-height: 1.55;
}

.home-faq {
  max-width: 53rem;
  margin: 1.875rem auto 0;
  text-align: left;
}

.home-faq-item {
  padding: 1.25rem 0;
  border-bottom: 1px solid var(--landing-border);
}

.home-faq-item h3 {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 650;
}

.home-faq-item p {
  margin: 0.5rem 0 0;
  color: var(--landing-ink-soft);
  font-size: 0.9375rem;
  line-height: 1.6;
}

.home-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--landing-muted);
}

.home-links a:hover {
  color: var(--landing-ink);
}

/* The credit hugs its own content so it sits flush against the footer's right
   edge; growing it left a gap between the sentence and the edge. */
.home-footer-acknowledgement {
  flex: 0 1 auto;
  min-width: 0;
}

@media (width <= 64rem) {
  .home-hero {
    grid-template-areas:
      "intro"
      "film"
      "get";
    grid-template-rows: none;
    grid-template-columns: minmax(0, 1fr);
  }

  .home-hero-get {
    width: min(100%, 27.5rem);
  }

  .home-grid-four {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (width <= 54rem) {
  .home-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (width <= 40rem) {
  /* One row: the brand on the left, the icon-only actions on the right. */
  .home-topbar {
    align-items: center;
    gap: 0.75rem;
    padding-bottom: 0.75rem;
    overflow-x: visible;
  }

  .home-brand {
    gap: 0.6rem;
    min-width: 0;
  }

  .home-actions {
    gap: 0.125rem;
  }

  .home-grid,
  .home-grid-four {
    grid-template-columns: minmax(0, 1fr);
  }

  .home-bottom {
    align-items: flex-start;
  }

  .home-footer-acknowledgement {
    flex-basis: 100%;
  }
}
</style>
