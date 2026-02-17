import {
    detectArchitecture,
    detectPlatform,
    getAssetExtension,
    isInstallerAsset,
    parseUserAgent,
    recommendInstaller,
    type LatestReleaseResponse,
    type ReleaseInstaller,
} from '~~/shared/releases';

interface GithubReleaseAsset {
    id: number
    name: string
    browser_download_url: string
    size: number
    updated_at: string
    content_type: string
}

interface GithubRelease {
    tag_name: string
    name: string
    published_at: string
    html_url: string
    assets: GithubReleaseAsset[]
}

export default defineEventHandler(async (event): Promise<LatestReleaseResponse> => {
    const config = useRuntimeConfig(event);
    const githubApiBase = String(config.githubApiBase || 'https://api.github.com').replace(/\/+$/, '');
    const githubOwner = String(config.githubOwner || 'evb0110');
    const githubRepo = String(config.githubRepo || 'electron-nuxt');
    const githubToken = String(config.githubToken || '');

    const headers: Record<string, string> = {
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
    };

    if (githubToken) {
        headers.authorization = `Bearer ${githubToken}`;
    }

    let release: GithubRelease;
    try {
        release = await $fetch<GithubRelease>(`${githubApiBase}/repos/${githubOwner}/${githubRepo}/releases/latest`, {headers});
    } catch (error) {
        console.error('Unable to fetch latest release', error);
        throw createError({
            statusCode: 502,
            statusMessage: 'Unable to fetch latest release data from GitHub',
        });
    }

    const installers = (release.assets || [])
        .filter(asset => isInstallerAsset(asset.name))
        .map<ReleaseInstaller>(asset => ({
            id: asset.id,
            name: asset.name,
            downloadUrl: asset.browser_download_url,
            size: asset.size,
            updatedAt: asset.updated_at,
            contentType: asset.content_type,
            extension: getAssetExtension(asset.name),
            platform: detectPlatform(asset.name),
            arch: detectArchitecture(asset.name),
        }));

    const clientHintsPlatform = getHeader(event, 'sec-ch-ua-platform')?.replace(/"/g, '') || '';
    const profile = parseUserAgent(getHeader(event, 'user-agent') || '', clientHintsPlatform);
    const recommended = recommendInstaller(installers, profile);

    setHeader(event, 'cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');

    return {
        release: {
            tag: release.tag_name,
            name: release.name || release.tag_name,
            publishedAt: release.published_at,
            htmlUrl: release.html_url,
        },
        assets: installers,
        recommendation: {
            platform: profile.platform,
            arch: profile.arch,
            assetId: recommended?.id || null,
        },
    };
});
