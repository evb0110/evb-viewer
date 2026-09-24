import {
    isIsoTimestamp,
    type TIsoTimestamp,
} from '@contracts/timestamps';
import {
    createReleaseCatalogLoader,
    fetchReleaseDataWithRetry,
    getReleaseFetchStatusCode,
    getMissingConfiguredReleaseTags,
    detectArchitecture,
    detectPlatform,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    normalizeCanaryPercent,
    parseReleaseTagList,
    selectReleaseForRollout,
    type ILatestReleaseResponse,
    type IReleaseInstaller,
} from '@releaseSelection';

interface IGithubReleaseAsset {
    id: number
    name: string
    browser_download_url: string
    size: number
    updated_at: string
    content_type: string
}

/** A GitHub asset whose wire timestamp has been checked against the ISO contract. */
type TDatedReleaseAsset = IGithubReleaseAsset & {updated_at: TIsoTimestamp};

const RELEASE_COHORT_COOKIE = 'evb_release_cohort';
const RELEASE_COHORT_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const releaseCatalogLoader = createReleaseCatalogLoader<TPublishedGithubRelease[]>();
// The core mirror is written and verified before a release is promoted, so
// core installers always have a mirror copy. The Windows ARM64 installer is
// built and mirrored after promotion, and only the object itself can say
// whether that finished.
const SUPPLEMENTAL_INSTALLER_PATTERN = /^EVB-Viewer-.+-arm64-setup\.exe$/u;
const MIRROR_PROBE_TIMEOUT_MS = 2_000;
// Mirror objects are immutable for as long as the tag stays in the retained
// window, so a hit stays true; a miss is rechecked soon because the
// supplemental workflow lands minutes after promotion.
const MIRROR_PROBE_HIT_TTL_MS = 60 * 60_000;
const MIRROR_PROBE_MISS_TTL_MS = 5 * 60_000;
const MIRROR_PROBE_CACHE_LIMIT = 32;
const mirrorProbeCache = new Map<string, {
    available: boolean
    checkedAt: number
}>();

function isSupplementalInstaller(assetName: string) {
    return SUPPLEMENTAL_INSTALLER_PATTERN.test(assetName);
}

function readCachedMirrorProbe(url: string, now: number) {
    const cached = mirrorProbeCache.get(url);
    if (!cached) {
        return null;
    }
    const ttlMs = cached.available ? MIRROR_PROBE_HIT_TTL_MS : MIRROR_PROBE_MISS_TTL_MS;
    return now - cached.checkedAt <= ttlMs ? cached.available : null;
}

function recordMirrorProbe(url: string, available: boolean, now: number) {
    if (mirrorProbeCache.size >= MIRROR_PROBE_CACHE_LIMIT) {
        for (const [
            cachedUrl,
            entry,
        ] of mirrorProbeCache) {
            if (now - entry.checkedAt > MIRROR_PROBE_MISS_TTL_MS) {
                mirrorProbeCache.delete(cachedUrl);
            }
        }
        // Every entry is still fresh, so the limit only holds if the oldest
        // one goes. Re-inserting below keeps the order by probe time.
        const oldestUrl = mirrorProbeCache.keys().next().value;
        if (mirrorProbeCache.size >= MIRROR_PROBE_CACHE_LIMIT && oldestUrl !== undefined) {
            mirrorProbeCache.delete(oldestUrl);
        }
    }
    mirrorProbeCache.delete(url);
    mirrorProbeCache.set(url, {
        available,
        checkedAt: now,
    });
}

async function isOnReleaseMirror(url: string) {
    const now = Date.now();
    const cached = readCachedMirrorProbe(url, now);
    if (cached !== null) {
        return cached;
    }

    let available = false;
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(MIRROR_PROBE_TIMEOUT_MS),
        });
        available = response.ok;
    } catch (error) {
        // A mirror that cannot answer costs the visitor nothing: the GitHub
        // download link is always rendered next to it.
        console.warn('Unable to probe the release mirror', {
            message: error instanceof Error ? error.message : String(error),
            outcome: 'mirror-link-omitted',
            url,
        });
    }
    recordMirrorProbe(url, available, now);
    return available;
}

async function resolveMirrorDownloadUrl(tag: string, assetName: string, mirrorBaseUrl: string) {
    if (!mirrorBaseUrl) {
        return null;
    }
    const url = `${mirrorBaseUrl}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
    if (!isSupplementalInstaller(assetName)) {
        return url;
    }
    return await isOnReleaseMirror(url) ? url : null;
}

function parseHttpsUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href.replace(/\/+$/u, '') : null;
    } catch {
        return null;
    }
}

function getReleaseCohortKey(event: Parameters<typeof getCookie>[0]) {
    const existingCohort = getCookie(event, RELEASE_COHORT_COOKIE);
    if (existingCohort && /^[a-f\d-]{16,64}$/iu.test(existingCohort)) {
        return existingCohort;
    }

    const cohortKey = crypto.randomUUID();
    setCookie(event, RELEASE_COHORT_COOKIE, cohortKey, {
        httpOnly: true,
        maxAge: RELEASE_COHORT_MAX_AGE_SECONDS,
        path: '/api/releases/latest',
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
    });
    return cohortKey;
}

interface IGithubRelease {
    draft?: boolean
    prerelease?: boolean
    tag_name: string
    // GitHub omits the name of an untitled release and the publish date of a draft.
    name: string | null
    published_at: string | null
    html_url: string
    assets?: IGithubReleaseAsset[]
}

/** A GitHub release whose wire timestamp has been checked against the ISO contract. */
type TPublishedGithubRelease = IGithubRelease & {published_at: TIsoTimestamp};

function isPublishedGithubRelease(release: IGithubRelease): release is TPublishedGithubRelease {
    return isIsoTimestamp(release.published_at);
}

async function toInstallers(release: IGithubRelease, mirrorBaseUrl: string) {
    const installers = await Promise.all((release.assets ?? [])
        .filter((asset): asset is TDatedReleaseAsset => isInstallerAsset(asset.name)
            && parseHttpsUrl(asset.browser_download_url) !== null
            && isIsoTimestamp(asset.updated_at))
        .map(async (asset) => {
            const mirrorDownloadUrl = await resolveMirrorDownloadUrl(
                release.tag_name,
                asset.name,
                mirrorBaseUrl,
            );
            const installer: IReleaseInstaller = {
                id: asset.id,
                name: asset.name,
                downloadUrl: asset.browser_download_url,
                ...(mirrorDownloadUrl ? {mirrorDownloadUrl} : {}),
                size: asset.size,
                updatedAt: asset.updated_at,
                contentType: asset.content_type,
                extension: getAssetExtension(asset.name),
                platform: detectPlatform(asset.name),
                arch: detectArchitecture(asset.name),
            };
            return installer;
        }));

    return normalizeInstallers(installers);
}

export default defineEventHandler(async (event): Promise<ILatestReleaseResponse> => {
    const config = useRuntimeConfig(event);
    setHeader(event, 'cache-control', 'private, no-store, max-age=0');

    const githubApiBase = parseHttpsUrl(String(config.githubApiBase || 'https://api.github.com'));
    if (!githubApiBase) {
        throw createError({
            statusCode: 500,
            statusMessage: 'GitHub API base URL must use HTTPS',
        });
    }
    const githubOwner = String(config.githubOwner || 'evb0110');
    const githubRepo = String(config.githubRepo || 'evb-viewer');
    const githubToken = String(config.githubToken || '');
    const releaseMirrorBaseUrl = parseHttpsUrl(String(config.releaseMirrorBaseUrl)) ?? '';
    const stableTags = parseReleaseTagList(String(config.releaseStableTags || ''));
    const canaryTag = String(config.releaseCanaryTag || '').trim() || null;
    const configuredTags = Array.from(new Set([
        ...stableTags,
        ...(canaryTag ? [canaryTag] : []),
    ]));

    const headers: Record<string, string> = {
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
    };

    if (githubToken && new URL(githubApiBase).hostname.toLowerCase() === 'api.github.com') {
        headers.authorization = `Bearer ${githubToken}`;
    }

    const githubRepositoryApiUrl = `${githubApiBase}/repos/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepo)}`;

    async function fetchReleaseCatalog(signal: AbortSignal): Promise<TPublishedGithubRelease[]> {
        const releases = await $fetch<IGithubRelease[]>(`${githubRepositoryApiUrl}/releases`, {
            headers,
            query: {per_page: 100},
            retry: 0,
            signal,
            timeout: 6_000,
        });
        const exactReleases = await Promise.all(getMissingConfiguredReleaseTags(releases, configuredTags)
            .map(async (tag) => {
                try {
                    return await $fetch<IGithubRelease>(
                        `${githubRepositoryApiUrl}/releases/tags/${encodeURIComponent(tag)}`,
                        {
                            headers,
                            retry: 0,
                            signal,
                            timeout: 6_000,
                        },
                    );
                } catch (error) {
                    if (getReleaseFetchStatusCode(error) === 404) {
                        return null;
                    }
                    throw error;
                }
            }));
        return [
            ...releases,
            ...exactReleases.filter((release): release is IGithubRelease => release !== null),
        ].filter(isPublishedGithubRelease);
    }

    let catalogResult: {
        catalog: TPublishedGithubRelease[]
        stale: boolean
    };
    try {
        const cacheKey = JSON.stringify([
            githubApiBase,
            githubOwner,
            githubRepo,
            configuredTags,
        ]);
        catalogResult = await releaseCatalogLoader({
            cacheKey,
            fetchCatalog: async () => {
                return fetchReleaseDataWithRetry({
                    fetchResult: fetchReleaseCatalog,
                    shouldRetryResult: catalog => catalog.length === 0,
                });
            },
            isUsableCatalog: catalog => catalog.length > 0,
        });
    } catch (error) {
        console.warn('Unable to fetch release catalog', {
            message: error instanceof Error ? error.message : String(error),
            outcome: 'temporarily-unavailable',
            statusCode: getReleaseFetchStatusCode(error) ?? undefined,
            statusMessage: typeof error === 'object' && error && 'statusMessage' in error ? error.statusMessage : undefined,
        });
        throw createError({
            statusCode: 503,
            statusMessage: 'Release catalog is temporarily unavailable',
        });
    }

    const release = selectReleaseForRollout(catalogResult.catalog, {
        canaryPercent: normalizeCanaryPercent(String(config.releaseCanaryPercent || '0')),
        canaryTag,
        stableTags,
        withdrawnTags: new Set(parseReleaseTagList(String(config.releaseWithdrawnTags || ''))),
    }, getReleaseCohortKey(event));
    if (!release) {
        throw createError({
            statusCode: 503,
            statusMessage: stableTags.length > 0
                ? 'No configured stable release is currently available'
                : 'No public release is currently available',
        });
    }
    const installers = await toInstallers(release, releaseMirrorBaseUrl);

    if (catalogResult.stale) {
        setHeader(event, 'x-evb-release-catalog', 'stale');
    }

    return {
        release: {
            tag: release.tag_name,
            name: release.name ?? release.tag_name,
            publishedAt: release.published_at,
            htmlUrl: parseHttpsUrl(release.html_url)
                ?? `https://github.com/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepo)}/releases/tag/${encodeURIComponent(release.tag_name)}`,
        },
        assets: installers,
        recommendation: {
            platform: 'unknown',
            arch: 'unknown',
            assetId: null,
        },
    };
});
