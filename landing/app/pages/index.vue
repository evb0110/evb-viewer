<template>
  <main aria-labelledby="home-title">
    <section class="hero-grid section-reveal">
      <div class="hero-copy">
        <UBadge
          :label="t('home.hero.badge')"
          color="primary"
          variant="subtle"
          class="hero-badge"
        />

        <h1
          id="home-title"
          class="hero-title"
        >
          {{ t('home.hero.title') }}
        </h1>

        <p class="hero-subtitle">
          {{ t('home.hero.subtitle') }}
        </p>

        <div class="hero-cta">
          <UButton
            :label="downloadPrimaryLabel"
            icon="i-lucide-download"
            size="xl"
            class="ring ring-inset ring-primary"
            @click="downloadActiveInstaller"
          />

          <UButton
            :label="t('home.hero.browseInstallers')"
            color="neutral"
            variant="outline"
            size="xl"
            icon="i-lucide-list"
            @click="scrollToInstallers"
          />
        </div>

        <p class="hero-hint">
          {{ recommendationHint }}
        </p>

        <p
          v-if="releaseData"
          class="release-meta"
        >
          <strong>{{ releaseData.release.tag }}</strong>
          <span v-if="releaseDateLabel"> &middot; {{ t('home.hero.published', { date: releaseDateLabel }) }}</span>
        </p>
      </div>

      <figure class="hero-preview">
        <div class="preview-frame">
          <img
            class="preview-image"
            src="/evb-viewer-preview-cropped.png"
            :alt="t('home.preview.alt')"
            width="2936"
            height="1935"
            loading="eager"
            decoding="async"
            fetchpriority="high"
          >
        </div>
        <figcaption class="preview-caption">
          {{ t('home.preview.caption') }}
        </figcaption>
      </figure>
    </section>

    <section
      id="installers"
      class="content-section section-reveal section-delay-1"
    >
      <div class="section-head">
        <h2>{{ t('home.installers.heading') }}</h2>
        <p>
          {{ t('home.installers.description') }}
        </p>
      </div>

      <div class="installer-card">
        <div
          v-if="status === 'pending'"
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
            @click="() => refresh()"
          />
        </div>

        <div
          v-else-if="installers.length"
          class="installer-content"
        >
          <div class="installer-platforms">
            <UButton
              v-for="platform in selectablePlatforms"
              :key="platform"
              :label="installerPlatformLabel(platform)"
              size="sm"
              :variant="selectedPlatform === platform ? 'solid' : 'ghost'"
              :color="selectedPlatform === platform ? 'primary' : 'neutral'"
              class="installer-platform-button"
              @click="selectPlatform(platform)"
            />
          </div>

          <div class="installer-list">
            <button
              v-for="installer in installersForSelectedPlatform"
              :key="installer.id"
              type="button"
              class="installer-item"
              :class="{ 'installer-item-recommended': isRecommendedInstaller(installer) }"
              @click="triggerIframeDownload(installer.downloadUrl)"
            >
              <div class="installer-item-info">
                <div class="installer-item-header">
                  <span class="installer-item-variant">{{ formatInstallerVariantLabel(installer) }}</span>
                  <span
                    v-if="isRecommendedInstaller(installer)"
                    class="installer-badge"
                  >
                    {{ t('home.installers.recommended') }}
                  </span>
                </div>
                <span class="installer-item-meta">
                  {{ installer.name }} · {{ formatFileSize(installer.size) }}
                </span>
              </div>
              <UIcon
                name="i-lucide-download"
                class="installer-item-icon"
              />
            </button>
          </div>
        </div>

        <div
          v-else
          class="installer-state"
        >
          <p>{{ t('home.installers.noArtifacts') }}</p>
        </div>
      </div>
    </section>

    <section class="content-section section-reveal section-delay-2">
      <div class="section-head">
        <h2>{{ t('home.explore.heading') }}</h2>
        <p>{{ t('home.explore.description') }}</p>
      </div>

      <div class="features-grid">
        <UCard
          v-for="feature in featureHighlights"
          :key="feature.title"
          class="feature-card"
        >
          <UIcon
            :name="feature.icon"
            class="feature-icon"
          />
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
        </UCard>
      </div>

      <div class="section-actions">
        <UButton
          :label="t('home.explore.featuresPage')"
          to="/features"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
        <UButton
          :label="t('home.explore.docsPage')"
          to="/docs"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import {
    buildAbsoluteUrl,
    normalizeSiteUrl,
} from '~~/shared/seo';
import {
    formatArch,
    formatExtension,
    formatFileSize,
    formatInstallerLabel,
    formatPlatform,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    type TReleaseArch,
    type IReleaseInstaller,
    type IUserAgentProfile,
    type TReleasePlatform,
} from '~~/shared/releases';

interface INavigatorUADataLike {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const { t } = useTypedI18n();
const { locale } = useI18n();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();

const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
const canonicalUrl = computed(() => buildAbsoluteUrl(siteUrl.value, route.path));
const ogImage = computed(() => buildAbsoluteUrl(siteUrl.value, '/evb-viewer-preview.png'));
const pageDescription = computed(() => t('home.seo.ogDescription'));

const featureHighlights = computed(() => [
    {
        icon: 'i-lucide-file-stack',
        title: t('home.features.pdfDjvu.title'),
        description: t('home.features.pdfDjvu.description'),
    },
    {
        icon: 'i-lucide-text-search',
        title: t('home.features.ocr.title'),
        description: t('home.features.ocr.description'),
    },
    {
        icon: 'i-lucide-pen-tool',
        title: t('home.features.annotations.title'),
        description: t('home.features.annotations.description'),
    },
]);

useSeoMeta({
    title: () => t('home.seo.title'),
    description: () => pageDescription.value,
    ogTitle: () => t('home.seo.ogTitle'),
    ogDescription: () => pageDescription.value,
    ogUrl: () => canonicalUrl.value,
    ogImage: () => ogImage.value,
    twitterTitle: () => t('home.seo.ogTitle'),
    twitterDescription: () => pageDescription.value,
    twitterImage: () => ogImage.value,
});

const clientProfile = ref<IUserAgentProfile>({
    platform: 'unknown',
    arch: 'unknown',
});

const INSTALLER_PLATFORM_ORDER: TReleasePlatform[] = [
    'macos',
    'windows',
    'linux',
    'unknown',
];

const INSTALLER_EXTENSION_ORDER: Record<TReleasePlatform, string[]> = {
    macos: [
        'dmg',
        'pkg',
        'zip',
    ],
    windows: [
        'exe',
        'msi',
    ],
    linux: [
        'deb',
        'appimage',
        'rpm',
        'tar.gz',
        'zip',
    ],
    unknown: [
        'dmg',
        'exe',
        'deb',
        'appimage',
        'zip',
    ],
};

const INSTALLER_ARCH_ORDER: Record<TReleaseArch, number> = {
    x64: 0,
    arm64: 1,
    universal: 2,
    unknown: 3,
};

const {
    data: releaseData,
    error,
    refresh,
    status,
} = useFetch('/api/releases/latest', {key: 'latest-release-data'});

const installers = computed(() => releaseData.value?.assets || []);

const selectablePlatforms = computed<TReleasePlatform[]>(() => INSTALLER_PLATFORM_ORDER.filter(
    platform => installers.value.some(asset => asset.platform === platform),
));

const recommendedInstaller = computed<IReleaseInstaller | null>(() => {
    if (!installers.value.length) {
        return null;
    }

    const clientSideChoice = recommendInstaller(installers.value, clientProfile.value);
    if (clientSideChoice) {
        return clientSideChoice;
    }

    const apiRecommendationId = releaseData.value?.recommendation.assetId;
    if (apiRecommendationId != null) {
        const apiRecommendation = installers.value.find(asset => asset.id === apiRecommendationId);
        if (apiRecommendation) {
            return apiRecommendation;
        }
    }

    return installers.value[0] || null;
});

const platformOverride = ref<TReleasePlatform | null>(null);
const assetIdOverride = ref<number | undefined>(undefined);

const selectedPlatform = computed<TReleasePlatform>(() => {
    if (platformOverride.value && selectablePlatforms.value.includes(platformOverride.value)) {
        return platformOverride.value;
    }

    const recPlatform = recommendedInstaller.value?.platform || 'unknown';
    if (selectablePlatforms.value.includes(recPlatform)) {
        return recPlatform;
    }

    return selectablePlatforms.value[0] || 'unknown';
});

const installersForSelectedPlatform = computed(() => {
    const platformAssets = installers.value.filter(asset => asset.platform === selectedPlatform.value);
    return selectPreferredInstallers(platformAssets).sort(compareInstallersForSelect);
});

const selectedAssetId = computed(() => {
    const items = installersForSelectedPlatform.value;
    if (!items.length) {
        return undefined;
    }

    if (assetIdOverride.value != null && items.some(a => a.id === assetIdOverride.value)) {
        return assetIdOverride.value;
    }

    const rec = recommendedInstaller.value;
    if (rec && rec.platform === selectedPlatform.value) {
        return rec.id;
    }

    return items[0]?.id;
});

const selectedInstaller = computed<IReleaseInstaller | null>(() => {
    if (!installersForSelectedPlatform.value.length) {
        return null;
    }

    const found = installersForSelectedPlatform.value.find(asset => asset.id === selectedAssetId.value);
    if (found) {
        return found;
    }

    return installersForSelectedPlatform.value[0] || null;
});

const activeDownload = computed(() => selectedInstaller.value || recommendedInstaller.value);
const fallbackReleaseUrl = computed(() => releaseData.value?.release.htmlUrl || `${repositoryUrl}/releases/latest`);
const softwareApplicationSchema = computed(() => {
    const latestRelease = releaseData.value?.release;

    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: t('app.title'),
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'macOS, Windows, Linux',
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

useHead(() => ({script: [{
    key: 'software-application-schema',
    type: 'application/ld+json',
    textContent: JSON.stringify(softwareApplicationSchema.value),
}]}));

const downloadPrimaryLabel = computed(() => {
    const installer = recommendedInstaller.value;
    if (!installer) {
        return t('home.hero.openLatestRelease');
    }

    const platform = formatPlatform(installer.platform);
    const arch = formatArch(installer.arch);
    if (arch) {
        return t('home.hero.downloadForArch', {
            platform,
            arch,
        });
    }

    return t('home.hero.downloadFor', { platform });
});

const recommendationHint = computed(() => {
    const installer = recommendedInstaller.value;
    if (!installer) {
        return t('home.hero.detectionUnavailable');
    }

    return t('home.hero.suggestedDevice', { installerLabel: formatInstallerLabel(installer) });
});

const releaseDateLabel = computed(() => {
    const publishedAt = releaseData.value?.release.publishedAt;
    if (!publishedAt) {
        return '';
    }

    const publishedDate = new Date(publishedAt);
    if (Number.isNaN(publishedDate.getTime())) {
        return '';
    }

    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(publishedDate);
});

onMounted(async () => {
    clientProfile.value = await detectClientProfile();
});

async function detectClientProfile(): Promise<IUserAgentProfile> {
    const uaProfile = parseUserAgent(navigator.userAgent);
    const uaData = (navigator as Navigator & { userAgentData?: INavigatorUADataLike }).userAgentData;

    if (!uaData) {
        return uaProfile;
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

    return {
        platform: hintedPlatform === 'unknown' ? uaProfile.platform : hintedPlatform,
        arch: hintedArch === 'unknown' ? uaProfile.arch : hintedArch,
    };
}

function triggerIframeDownload(url: string) {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    iframe.src = url;
    setTimeout(() => iframe.remove(), 60_000);
}

function downloadActiveInstaller() {
    const installer = activeDownload.value;
    if (installer) {
        triggerIframeDownload(installer.downloadUrl);
    } else {
        window.open(fallbackReleaseUrl.value, '_blank');
    }
}

function isRecommendedInstaller(installer: IReleaseInstaller) {
    return recommendedInstaller.value?.id === installer.id;
}

function scrollToInstallers() {
    document.getElementById('installers')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });
}

function selectPlatform(platform: TReleasePlatform) {
    platformOverride.value = platform;
    assetIdOverride.value = undefined;
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

function compareInstallersForSelect(left: IReleaseInstaller, right: IReleaseInstaller): number {
    const extensionDiff = installerExtensionRank(left) - installerExtensionRank(right);
    if (extensionDiff !== 0) {
        return extensionDiff;
    }

    const archDiff = INSTALLER_ARCH_ORDER[left.arch] - INSTALLER_ARCH_ORDER[right.arch];
    if (archDiff !== 0) {
        return archDiff;
    }

    return left.name.localeCompare(right.name);
}

function effectiveArch(asset: IReleaseInstaller): TReleaseArch {
    return asset.arch === 'unknown' ? 'x64' : asset.arch;
}

function formatInstallerVariantLabel(asset: IReleaseInstaller): string {
    const arch = formatArch(effectiveArch(asset));
    const extension = formatExtension(asset.extension);

    if (arch) {
        return `${arch} (${extension})`;
    }

    return extension;
}

function selectPreferredInstallers(assets: IReleaseInstaller[]): IReleaseInstaller[] {
    const first = assets[0];
    if (!first) {
        return assets;
    }

    const formatOrder = INSTALLER_EXTENSION_ORDER[first.platform] || INSTALLER_EXTENSION_ORDER.unknown;

    const byArch = new Map<TReleaseArch, IReleaseInstaller[]>();
    for (const asset of assets) {
        const arch = effectiveArch(asset);
        const group = byArch.get(arch) || [];
        group.push(asset);
        byArch.set(arch, group);
    }

    const result: IReleaseInstaller[] = [];
    for (const [
        , archAssets,
    ] of byArch) {
        const firstOfArch = archAssets[0];
        if (!firstOfArch) continue;

        let best = firstOfArch;
        let bestRank = formatOrder.indexOf(best.extension);
        if (bestRank === -1) bestRank = 999;

        for (const asset of archAssets.slice(1)) {
            let rank = formatOrder.indexOf(asset.extension);
            if (rank === -1) rank = 999;
            if (rank < bestRank) {
                best = asset;
                bestRank = rank;
            }
        }
        result.push(best);
    }

    return result;
}

function installerExtensionRank(asset: IReleaseInstaller): number {
    const preferenceOrder = INSTALLER_EXTENSION_ORDER[asset.platform] || INSTALLER_EXTENSION_ORDER.unknown;
    const index = preferenceOrder.indexOf(asset.extension);
    if (index !== -1) {
        return index;
    }

    return preferenceOrder.length + 4;
}
</script>
