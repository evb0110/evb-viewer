import {
    detectArchitecture,
    detectPlatform,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    parseUserAgent,
    recommendInstaller,
    type ILatestReleaseResponse,
    type IReleaseInstaller,
} from '~~/shared/releases';

interface IGithubReleaseAsset {
    id: number
    name: string
    browser_download_url: string
    size: number
    updated_at: string
    content_type: string
}

interface IGithubRelease {
    tag_name: string
    name: string
    published_at: string
    html_url: string
    assets: IGithubReleaseAsset[]
}

function toInstallers(release: IGithubRelease): IReleaseInstaller[] {
    const installers = (release.assets || [])
        .filter(asset => isInstallerAsset(asset.name))
        .map<IReleaseInstaller>(asset => ({
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

    return normalizeInstallers(installers);
}

export default defineEventHandler(async (event): Promise<ILatestReleaseResponse> => {
    const config = useRuntimeConfig(event);
    const githubApiBase = String(config.githubApiBase || 'https://api.github.com').replace(/\/+$/, '');
    const githubOwner = String(config.githubOwner || 'evb0110');
    const githubRepo = String(config.githubRepo || 'evb-viewer');
    const githubToken = String(config.githubToken || '');

    const headers: Record<string, string> = {
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
    };

    if (githubToken) {
        headers.authorization = `Bearer ${githubToken}`;
    }

    async function fetchLatestRelease(): Promise<IGithubRelease> {
        return $fetch<IGithubRelease>(`${githubApiBase}/repos/${githubOwner}/${githubRepo}/releases/latest`, { headers });
    }

    let release: IGithubRelease;
    try {
        release = await fetchLatestRelease();
    } catch (error) {
        console.error('Unable to fetch latest release', error);
        throw createError({
            statusCode: 502,
            statusMessage: 'Unable to fetch latest release data from GitHub',
        });
    }

    let installers = toInstallers(release);
    if (!installers.length) {
        for (let attempt = 0; attempt < 2; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 450 * (attempt + 1)));

            try {
                release = await fetchLatestRelease();
                installers = toInstallers(release);
                if (installers.length) {
                    break;
                }
            } catch {
                break;
            }
        }
    }

    const clientHintsPlatform = getHeader(event, 'sec-ch-ua-platform')?.replace(/"/g, '') || '';
    const profile = parseUserAgent(getHeader(event, 'user-agent') || '', clientHintsPlatform);
    const recommended = recommendInstaller(installers, profile);

    if (installers.length) {
        setHeader(event, 'cache-control', 'public, s-maxage=600, stale-while-revalidate=3600');
    } else {
        setHeader(event, 'cache-control', 'public, s-maxage=45, stale-while-revalidate=120');
    }

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
