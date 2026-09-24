<template>
  <main
    class="home-shell"
    aria-labelledby="home-title"
  >
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
          :to="webAppUrl"
          target="_blank"
          rel="noreferrer"
          color="neutral"
          variant="ghost"
          size="md"
          icon="i-ph-globe"
        />

        <LanguageSwitcher />

        <UButton
          :to="GITHUB_REPOSITORY_URL"
          target="_blank"
          rel="noreferrer"
          color="neutral"
          variant="outline"
          size="md"
          icon="i-simple-icons-github"
          square
          :aria-label="t('footer.viewSource')"
        />
      </div>
    </header>

    <section class="home-main">
      <div class="home-content">
        <div class="hero-copy">
          <p class="hero-eyebrow">
            {{ t('home.hero.badge') }}
          </p>

          <h1
            id="home-title"
            class="hero-title"
          >
            {{ t('home.hero.title') }}
          </h1>

          <p class="hero-subtitle">
            {{ t('home.hero.subtitle') }}
          </p>

          <p class="hero-ai-note">
            {{ t('home.hero.aiNote') }}
          </p>
        </div>

        <div
          id="installers"
          class="installer-card installer-card-compact"
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

            <div class="installer-list-slot">
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
      </div>

      <figure class="hero-preview">
        <div class="preview-frame">
          <img
            class="preview-image"
            src="/evb-viewer-preview-cropped.png"
            :alt="t('home.preview.alt')"
            width="2918"
            height="1898"
            loading="eager"
            decoding="async"
            fetchpriority="high"
          >
        </div>
      </figure>
    </section>

    <footer class="home-bottom">
      <span class="home-copyright">{{ t('footer.copyright') }}</span>
      <SentryAcknowledgement class="home-footer-acknowledgement" />
    </footer>
  </main>
</template>

<script setup lang="ts">
import { track } from '@vercel/analytics';
import { GITHUB_REPOSITORY_URL } from '~/constants/githubRepositoryUrl';
import { selectInstallersForPlatform } from '~~/shared/selectInstallersForPlatform';
import SentryAcknowledgement from '~/components/SentryAcknowledgement.vue';
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

const { t } = useTypedI18n();
const localePath = useLocalePath();
const runtimeConfig = useRuntimeConfig();

const MICROSOFT_STORE_URL = 'https://apps.microsoft.com/detail/9N3MB1WJGX1L';

const webAppUrl = computed(() => runtimeConfig.public.webAppUrl.trim() || '');
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
/* The credit hugs its own content so it sits flush against the footer's right
   edge; growing it left a gap between the sentence and the edge. */
.home-footer-acknowledgement {
  flex: 0 1 auto;
  min-width: 0;
}

@media (width <= 40rem) {
  .home-bottom {
    align-items: flex-start;
  }

  .home-footer-acknowledgement {
    flex-basis: 100%;
  }
}
</style>
