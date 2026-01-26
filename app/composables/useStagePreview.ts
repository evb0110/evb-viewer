import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import type {
    IProcessingProject,
    TProcessingStage,
} from 'electron/page-processing/project';
import { getElectronAPI } from '@app/utils/electron';

/**
 * Cache entry for a preview image
 */
interface IPreviewCacheEntry {
    url: string;
    timestamp: number;
    paramsHash: string;
}

/**
 * Cache key format: `${projectId}:${pageNumber}:${stage}`
 */
type TPreviewCacheKey = string;

/**
 * Maximum age for cached previews (5 minutes)
 */
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Maximum number of cached previews
 */
const CACHE_MAX_ENTRIES = 50;

/**
 * Composable for managing stage preview generation and caching.
 * Handles fetching preview images from IPC and maintaining a client-side cache.
 */
export const useStagePreview = (
    projectRef: () => IProcessingProject | null,
) => {
    const previewUrl = ref<string | null>(null);
    const previewLoading = ref(false);
    const previewError = ref<string | null>(null);
    const currentPreviewPage = ref<number | null>(null);
    const currentPreviewStage = ref<TProcessingStage | null>(null);

    // Preview cache using shallow ref for performance
    const previewCache = shallowRef<Map<TPreviewCacheKey, IPreviewCacheEntry>>(new Map());

    // Track active fetch to avoid duplicate requests
    let activeFetchKey: string | null = null;

    /**
     * Generates a cache key for a preview.
     */
    function getCacheKey(projectId: string, pageNumber: number, stage: TProcessingStage): TPreviewCacheKey {
        return `${projectId}:${pageNumber}:${stage}`;
    }

    /**
     * Computes a simple hash of parameters for cache invalidation.
     */
    function computeParamsHash(project: IProcessingProject, pageNumber: number, stage: TProcessingStage): string {
        const pageIndex = pageNumber - 1;
        const page = project.pages[pageIndex];
        if (!page) {
            return 'no-page';
        }

        // Include relevant parameters for this stage
        const params: Record<string, unknown> = {
            stage,
            globalSettings: project.globalSettings,
        };

        // Add stage-specific parameters from the flat page model
        switch (stage) {
            case 'rotation':
                params.rotation = page.rotation ?? page.autoDetected.rotation;
                break;
            case 'split':
                params.rotation = page.rotation ?? page.autoDetected.rotation;
                params.split = page.split ?? page.autoDetected.split;
                break;
            case 'deskew':
                params.rotation = page.rotation ?? page.autoDetected.rotation;
                params.split = page.split ?? page.autoDetected.split;
                params.deskew = page.deskew ?? page.autoDetected.deskew;
                break;
            case 'dewarp':
                params.rotation = page.rotation ?? page.autoDetected.rotation;
                params.split = page.split ?? page.autoDetected.split;
                params.deskew = page.deskew ?? page.autoDetected.deskew;
                params.dewarp = page.dewarp ?? page.autoDetected.dewarp;
                break;
            case 'content':
                params.contentRect = page.contentRect ?? page.autoDetected.contentRect;
                break;
            case 'margins':
                params.margins = page.margins ?? project.globalSettings.defaultMargins;
                break;
            case 'output':
                params.outputSettings = project.outputSettings;
                break;
        }

        // Simple hash using JSON stringify
        return JSON.stringify(params);
    }

    /**
     * Checks if a cached preview is still valid.
     */
    function isCacheValid(entry: IPreviewCacheEntry, expectedHash: string): boolean {
        const now = Date.now();
        const age = now - entry.timestamp;

        // Check age
        if (age > CACHE_MAX_AGE_MS) {
            return false;
        }

        // Check params hash
        if (entry.paramsHash !== expectedHash) {
            return false;
        }

        return true;
    }

    /**
     * Evicts old entries from the cache to stay under the limit.
     */
    function evictOldEntries(): void {
        const cache = previewCache.value;

        if (cache.size <= CACHE_MAX_ENTRIES) {
            return;
        }

        // Sort entries by timestamp and remove oldest
        const entries = Array.from(cache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

        const toRemove = entries.slice(0, cache.size - CACHE_MAX_ENTRIES);

        for (const [
            key,
            entry,
        ] of toRemove) {
            // Revoke blob URL if it exists
            if (entry.url.startsWith('blob:')) {
                URL.revokeObjectURL(entry.url);
            }
            cache.delete(key);
        }

        // Trigger reactivity
        previewCache.value = new Map(cache);
    }

    /**
     * Adds an entry to the cache.
     */
    function addToCache(key: TPreviewCacheKey, url: string, paramsHash: string): void {
        const cache = new Map(previewCache.value);

        cache.set(key, {
            url,
            timestamp: Date.now(),
            paramsHash,
        });

        previewCache.value = cache;
        evictOldEntries();
    }

    /**
     * Removes an entry from the cache.
     */
    function removeFromCache(key: TPreviewCacheKey): void {
        const cache = previewCache.value;
        const entry = cache.get(key);

        if (entry) {
            // Revoke blob URL if it exists
            if (entry.url.startsWith('blob:')) {
                URL.revokeObjectURL(entry.url);
            }
            cache.delete(key);
            previewCache.value = new Map(cache);
        }
    }

    /**
     * Fetches a preview for a specific page and stage.
     */
    async function fetchPreview(pageNumber: number, stage: TProcessingStage): Promise<string | null> {
        const project = projectRef();
        if (!project) {
            previewError.value = 'No project loaded';
            return null;
        }

        const cacheKey = getCacheKey(project.id, pageNumber, stage);
        const paramsHash = computeParamsHash(project, pageNumber, stage);

        // Check cache first
        const cached = previewCache.value.get(cacheKey);
        if (cached && isCacheValid(cached, paramsHash)) {
            previewUrl.value = cached.url;
            currentPreviewPage.value = pageNumber;
            currentPreviewStage.value = stage;
            return cached.url;
        }

        // Avoid duplicate requests
        if (activeFetchKey === cacheKey) {
            return null;
        }

        activeFetchKey = cacheKey;
        previewLoading.value = true;
        previewError.value = null;

        try {
            const api = getElectronAPI();

            // Call IPC to get preview
            const response = await api.pageProcessing.previewStage({
                projectId: project.id,
                pageNumber,
                stage,
            });

            if (!response.success) {
                throw new Error(response.error ?? 'Failed to generate preview');
            }

            let url: string;

            if (response.previewPath) {
                // Use file URL
                url = `file://${response.previewPath}`;
            } else {
                throw new Error('No preview path received');
            }

            // Update cache
            addToCache(cacheKey, url, paramsHash);

            // Update current preview
            previewUrl.value = url;
            currentPreviewPage.value = pageNumber;
            currentPreviewStage.value = stage;

            return url;
        } catch (e) {
            previewError.value = e instanceof Error ? e.message : 'Failed to fetch preview';
            return null;
        } finally {
            previewLoading.value = false;
            activeFetchKey = null;
        }
    }

    /**
     * Invalidates the cache for a specific page and stage.
     */
    function invalidatePreview(pageNumber: number, stage: TProcessingStage): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        const cacheKey = getCacheKey(project.id, pageNumber, stage);
        removeFromCache(cacheKey);

        // Clear current preview if it matches
        if (currentPreviewPage.value === pageNumber && currentPreviewStage.value === stage) {
            previewUrl.value = null;
        }
    }

    /**
     * Invalidates all cached previews for a page (all stages).
     */
    function invalidatePagePreviews(pageNumber: number): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        const stages: TProcessingStage[] = [
            'rotation',
            'split',
            'deskew',
            'dewarp',
            'content',
            'margins',
            'output',
        ];

        for (const stage of stages) {
            const cacheKey = getCacheKey(project.id, pageNumber, stage);
            removeFromCache(cacheKey);
        }

        // Clear current preview if it matches
        if (currentPreviewPage.value === pageNumber) {
            previewUrl.value = null;
        }
    }

    /**
     * Invalidates all cached previews for a stage (all pages).
     */
    function invalidateStagePreviews(stage: TProcessingStage): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        for (let i = 1; i <= project.pages.length; i++) {
            const cacheKey = getCacheKey(project.id, i, stage);
            removeFromCache(cacheKey);
        }

        // Clear current preview if stage matches
        if (currentPreviewStage.value === stage) {
            previewUrl.value = null;
        }
    }

    /**
     * Clears all cached previews.
     */
    function clearCache(): void {
        const cache = previewCache.value;

        // Revoke all blob URLs
        for (const entry of cache.values()) {
            if (entry.url.startsWith('blob:')) {
                URL.revokeObjectURL(entry.url);
            }
        }

        previewCache.value = new Map();
        previewUrl.value = null;
        currentPreviewPage.value = null;
        currentPreviewStage.value = null;
    }

    /**
     * Prefetches previews for nearby pages.
     */
    function prefetchNearbyPages(centerPage: number, stage: TProcessingStage, radius = 2): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        const pages: number[] = [];

        for (let i = centerPage - radius; i <= centerPage + radius; i++) {
            if (i >= 1 && i <= project.pages.length && i !== centerPage) {
                pages.push(i);
            }
        }

        // Fetch in parallel but don't wait
        for (const pageNum of pages) {
            fetchPreview(pageNum, stage).catch(() => {
                // Ignore prefetch errors
            });
        }
    }

    const cacheSize = computed(() => previewCache.value.size);

    const hasCachedPreview = computed(() => {
        if (currentPreviewPage.value === null || currentPreviewStage.value === null) {
            return false;
        }

        const project = projectRef();
        if (!project) {
            return false;
        }

        const cacheKey = getCacheKey(project.id, currentPreviewPage.value, currentPreviewStage.value);
        return previewCache.value.has(cacheKey);
    });

    return {
        // State
        previewUrl,
        previewLoading,
        previewError,
        currentPreviewPage,
        currentPreviewStage,

        // Computed
        cacheSize,
        hasCachedPreview,

        // Methods
        fetchPreview,
        invalidatePreview,
        invalidatePagePreviews,
        invalidateStagePreviews,
        clearCache,
        prefetchNearbyPages,
    };
};
