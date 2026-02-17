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
    type LatestReleaseResponse,
    type ReleaseArch,
    type ReleaseInstaller,
    type UserAgentProfile,
} from '~~/shared/releases';

interface NavigatorUADataLike {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const repositoryUrl = 'https://github.com/evb0110/electron-nuxt';

const featureHighlights = [
    {
        icon: 'i-lucide-file-stack',
        title: 'PDF + DjVu in one app',
        description: 'Read both formats, convert scans, and keep one consistent desktop workflow.',
    },
    {
        icon: 'i-lucide-text-search',
        title: 'High-accuracy OCR',
        description: 'Generate searchable PDFs with bundled `tessdata_best` language models.',
    },
    {
        icon: 'i-lucide-pen-tool',
        title: 'Annotation workflow',
        description: 'Highlight, draw, comment, and export your notes directly back into the file.',
    },
];

useSeoMeta({
    title: 'Home',
    ogTitle: 'EVB Viewer',
    ogDescription: 'Cross-platform desktop viewer for PDF and DjVu with OCR and advanced annotation tools.',
});

const clientProfile = ref<UserAgentProfile>({
    platform: 'unknown',
    arch: 'unknown',
});

const selectedAssetId = ref<number | null>(null);

const {
    data: releaseData,
    error,
    refresh,
    status,
} = useFetch<LatestReleaseResponse>('/api/releases/latest', {
    key: 'latest-release-data',
    lazy: true,
    server: false,
});

const installers = computed(() => releaseData.value?.assets || []);

const recommendedInstaller = computed<ReleaseInstaller | null>(() => {
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

const selectedInstaller = computed<ReleaseInstaller | null>(() => {
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
        return 'Open latest release';
    }

    const platform = formatPlatform(installer.platform);
    const arch = formatArch(installer.arch);
    if (arch) {
        return `Download for ${platform} (${arch})`;
    }

    return `Download for ${platform}`;
});

const recommendationHint = computed(() => {
    const installer = recommendedInstaller.value;
    if (!installer) {
        return 'Automatic platform detection is unavailable. Choose an installer below.';
    }

    return `Suggested for your device: ${formatInstallerLabel(installer)}`;
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

    return new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(publishedDate);
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

async function detectClientProfile(): Promise<UserAgentProfile> {
    const uaProfile = parseUserAgent(navigator.userAgent);
    const uaData = (navigator as Navigator & { userAgentData?: NavigatorUADataLike }).userAgentData;

    if (!uaData) {
        return uaProfile;
    }

    const hintedPlatform = parsePlatformHint(uaData.platform);
    let hintedArch: ReleaseArch = 'unknown';

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

function scrollToInstallers(): void {
    document.getElementById('installers')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });
}
</script>

<template>
  <div>
    <section class="hero-grid section-reveal">
      <div class="hero-copy">
        <UBadge
          label="Cross-platform desktop release"
          color="primary"
          variant="subtle"
          class="hero-badge"
        />

        <h1 class="hero-title">
          Read, annotate, OCR, and export documents without switching tools.
        </h1>

        <p class="hero-subtitle">
          EVB Viewer combines PDF.js rendering, DjVu support, OCR, page operations, and
          annotation workflows in a single desktop app for macOS, Windows, and Linux.
        </p>

        <div class="hero-cta">
          <UButton
            :label="downloadPrimaryLabel"
            :to="activeDownload?.downloadUrl || fallbackReleaseUrl"
            target="_blank"
            icon="i-lucide-download"
            size="xl"
          />

          <UButton
            label="Browse all installers"
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
          <span v-if="releaseDateLabel"> · Published {{ releaseDateLabel }}</span>
        </p>
      </div>

      <UCard
        class="hero-preview-card"
        :ui="{ body: 'p-0 sm:p-0' }"
      >
        <div class="preview-shell">
          <img
            class="preview-image"
            src="/evb-viewer-preview.png"
            alt="EVB Viewer screenshot"
          >
          <p class="preview-caption">
            Built for heavy document workflows: tabs, split views, OCR, and annotation tooling.
          </p>
        </div>
      </UCard>
    </section>

    <section
      id="installers"
      class="content-section section-reveal section-delay-1"
    >
      <div class="section-head">
        <h2>Installer recommendation</h2>
        <p>
          The primary button is selected from your browser user agent. You can always choose another build.
        </p>
      </div>

      <UCard class="installer-card">
        <div
          v-if="status === 'pending'"
          class="installer-state"
        >
          <p>Loading latest release links...</p>
        </div>

        <div
          v-else-if="error"
          class="installer-state"
        >
          <p>Could not load release artifacts right now.</p>
          <UButton
            label="Retry"
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
            Select installer
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
            {{ selectedInstaller.name }} · {{ formatFileSize(selectedInstaller.size) }}
          </p>

          <div class="installer-actions">
            <UButton
              label="Download selected installer"
              :to="selectedInstaller?.downloadUrl || fallbackReleaseUrl"
              target="_blank"
              icon="i-lucide-download"
            />
          </div>
        </div>

        <div
          v-else
          class="installer-state"
        >
          <p>No installer artifacts found in the latest release.</p>
        </div>
      </UCard>
    </section>

    <section class="content-section section-reveal section-delay-2">
      <div class="section-head">
        <h2>Explore EVB Viewer</h2>
        <p>Use dedicated pages for in-depth features and full documentation.</p>
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
          label="Open full features page"
          to="/features"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
        <UButton
          label="Open full documentation"
          to="/docs"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
      </div>
    </section>
  </div>
</template>
