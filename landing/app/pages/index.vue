<template>
  <div>
    <section class="hero-grid section-reveal">
      <div class="hero-copy">
        <UBadge
          :label="t('home.hero.badge')"
          color="primary"
          variant="subtle"
          class="hero-badge"
        />

        <h1 class="hero-title">
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

      <UCard class="installer-card">
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
          <label
            class="installer-label"
            for="installer-select"
          >
            {{ t('home.installers.selectLabel') }}
          </label>

          <select
            id="installer-select"
            v-model.number="selectedAssetId"
            class="installer-select"
          >
            <option
              v-for="asset in installers"
              :key="asset.id"
              :value="asset.id"
            >
              {{ formatInstallerLabel(asset) }}
            </option>
          </select>

          <p
            v-if="selectedInstaller"
            class="installer-details"
          >
            {{ t('home.installers.details', { name: selectedInstaller.name, size: formatFileSize(selectedInstaller.size) }) }}
          </p>

          <div class="installer-actions">
            <UButton
              :label="t('home.installers.downloadSelected')"
              icon="i-lucide-download"
              @click="downloadSelectedInstaller"
            />
          </div>
        </div>

        <div
          v-else
          class="installer-state"
        >
          <p>{{ t('home.installers.noArtifacts') }}</p>
        </div>
      </UCard>
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
  </div>
</template>

<script setup lang="ts">
import {
    formatArch,
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
} from '~~/shared/releases';

interface INavigatorUADataLike {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const { t } = useTypedI18n();
const { locale } = useI18n();

const repositoryUrl = 'https://github.com/evb0110/evb-viewer';

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
    ogTitle: () => t('home.seo.ogTitle'),
    ogDescription: () => t('home.seo.ogDescription'),
});

const clientProfile = ref<IUserAgentProfile>({
    platform: 'unknown',
    arch: 'unknown',
});

const selectedAssetId = ref<number | null>(null);

const {
    data: releaseData,
    error,
    refresh,
    status,
} = useFetch('/api/releases/latest', {key: 'latest-release-data'});

const installers = computed(() => releaseData.value?.assets || []);

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

const selectedInstaller = computed<IReleaseInstaller | null>(() => {
    if (!installers.value.length) {
        return null;
    }

    const found = installers.value.find(asset => asset.id === selectedAssetId.value);
    if (found) {
        return found;
    }

    return recommendedInstaller.value;
});

const activeDownload = computed(() => selectedInstaller.value || recommendedInstaller.value);
const fallbackReleaseUrl = computed(() => releaseData.value?.release.htmlUrl || `${repositoryUrl}/releases/latest`);

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

watch([
    installers,
    recommendedInstaller,
], ([
    nextInstallers,
    nextRecommendation,
]) => {
    if (!nextInstallers.length) {
        selectedAssetId.value = null;
        return;
    }

    const hasSelection = nextInstallers.some(asset => asset.id === selectedAssetId.value);
    if (!hasSelection) {
        const fallbackInstaller = nextInstallers[0];
        if (fallbackInstaller) {
            selectedAssetId.value = nextRecommendation?.id || fallbackInstaller.id;
        }
    }
}, { immediate: true });

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

function downloadSelectedInstaller() {
    const installer = selectedInstaller.value;
    if (installer) {
        triggerIframeDownload(installer.downloadUrl);
    } else {
        window.open(fallbackReleaseUrl.value, '_blank');
    }
}

function scrollToInstallers() {
    document.getElementById('installers')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });
}
</script>
