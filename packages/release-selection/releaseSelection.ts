import type {
    IReleaseInstaller,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts/release';
import {
    groupBy,
    orderBy,
    uniq,
} from 'es-toolkit/array';

const INSTALLER_EXTENSIONS = new Set([
    'appimage',
    'deb',
    'dmg',
    'exe',
    'msi',
    'pkg',
    'rpm',
    'tar.gz',
    'zip',
]);

const NON_INSTALLER_SUFFIXES = [
    '.blockmap',
    '.sha256',
    '.sha512',
    '.sig',
    '.txt',
    '.xml',
    '.yml',
    '.yaml',
];

const UNSUPPORTED_BROWSER_PLATFORM_PATTERN = /(^|[^a-z0-9])(android|chrome\s*os|cros|ios|ipados|ipad|iphone|ipod|mobile)([^a-z0-9]|$)/i;

function isUnsupportedBrowserPlatform(value: string) {
    return UNSUPPORTED_BROWSER_PLATFORM_PATTERN.test(value);
}

export const INSTALLER_PLATFORM_ORDER = [
    'macos',
    'windows',
    'linux',
    'unknown',
] as const satisfies readonly TReleasePlatform[];

const PREFERRED_EXTENSION_ORDER: Record<TReleasePlatform, string[]> = {
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

const EXTENSION_LABEL: Record<string, string> = {
    appimage: 'AppImage',
    deb: 'DEB',
    dmg: 'DMG',
    exe: 'EXE',
    msi: 'MSI',
    pkg: 'PKG',
    rpm: 'RPM',
    'tar.gz': 'TAR.GZ',
    zip: 'ZIP',
};

const INSTALLER_ARCH_ORDER: Record<TReleaseArch, number> = {
    x64: 0,
    arm64: 1,
    universal: 2,
    unknown: 3,
};

export function getAssetExtension(assetName: string) {
    const lowerName = assetName.toLowerCase();

    if (lowerName.endsWith('.tar.gz')) {
        return 'tar.gz';
    }

    const lastDot = lowerName.lastIndexOf('.');
    if (lastDot === -1) {
        return '';
    }

    return lowerName.slice(lastDot + 1);
}

export function isInstallerAsset(assetName: string) {
    const lowerName = assetName.toLowerCase();

    if (NON_INSTALLER_SUFFIXES.some(suffix => lowerName.endsWith(suffix))) {
        return false;
    }

    if (lowerName.includes('latest-mac') || lowerName.includes('latest-linux') || lowerName.includes('latest.yml')) {
        return false;
    }

    return INSTALLER_EXTENSIONS.has(getAssetExtension(assetName));
}

export function isLegacyInstallerAsset(assetName: string) {
    return assetName.toLowerCase().includes('legacy');
}

export function detectPlatform(assetName: string): TReleasePlatform {
    const lowerName = assetName.toLowerCase();
    const extension = getAssetExtension(assetName);

    if (
        lowerName.includes('darwin')
        || lowerName.includes('mac')
        || extension === 'dmg'
        || extension === 'pkg'
    ) {
        return 'macos';
    }

    if (
        lowerName.includes('win')
        || extension === 'exe'
        || extension === 'msi'
    ) {
        return 'windows';
    }

    if (
        lowerName.includes('linux')
        || extension === 'appimage'
        || extension === 'deb'
        || extension === 'rpm'
        || extension === 'tar.gz'
    ) {
        return 'linux';
    }

    // macOS is the only target that publishes ZIPs here, and mac artifactName
    // always embeds the architecture. scripts/release/policy.mjs states the same
    // invariant from the publishing side: Windows x64 ships as "-x64-setup.exe"
    // and the Store package as "-x64-store.appx", so the macOS Intel ZIP is the
    // only released "-x64.zip". Without this the supplemental Intel ZIP -- the
    // only Intel Mac download the project ships -- falls into the unknown bucket
    // and disappears from the macOS downloads. A ZIP carrying no architecture
    // token stays unclassified rather than being guessed at.
    if (extension === 'zip' && detectArchitecture(lowerName) !== 'unknown') {
        return 'macos';
    }

    return 'unknown';
}

export function detectArchitecture(assetName: string): TReleaseArch {
    const lowerName = assetName.toLowerCase();

    if (/\b(universal|all)\b/.test(lowerName)) {
        return 'universal';
    }

    if (/(arm64|aarch64|armv8)/.test(lowerName)) {
        return 'arm64';
    }

    if (/(x64|x86_64|amd64|win64)/.test(lowerName)) {
        return 'x64';
    }

    return 'unknown';
}

export function parsePlatformHint(hint: string | null | undefined): TReleasePlatform {
    const normalizedHint = (hint ?? '').toLowerCase();

    if (isUnsupportedBrowserPlatform(normalizedHint)) {
        return 'unknown';
    }

    if (normalizedHint.includes('mac') || normalizedHint.includes('darwin')) {
        return 'macos';
    }

    if (normalizedHint.includes('win')) {
        return 'windows';
    }

    if (normalizedHint.includes('linux')) {
        return 'linux';
    }

    return 'unknown';
}

export function parseArchitectureHint(hint: string | null | undefined): TReleaseArch {
    const normalizedHint = (hint ?? '').toLowerCase();

    if (/(^|[^a-z0-9])(arm64|aarch64|arm)([^a-z0-9]|$)/.test(normalizedHint)) {
        return 'arm64';
    }

    if (/(^|[^a-z0-9])(x86_64|x86-64|x64|amd64|x86)([^a-z0-9]|$)/.test(normalizedHint)) {
        return 'x64';
    }

    return 'unknown';
}

export function parseUserAgent(userAgent: string, platformHint = ''): IUserAgentProfile {
    const normalized = `${platformHint} ${userAgent}`.toLowerCase();

    if (isUnsupportedBrowserPlatform(normalized)) {
        return {
            platform: 'unknown',
            arch: 'unknown',
        };
    }

    let platform: TReleasePlatform = 'unknown';
    if (/(macintosh|mac os x|darwin)/.test(normalized)) {
        platform = 'macos';
    } else if (/(windows|win32|win64)/.test(normalized)) {
        platform = 'windows';
    } else if (/(linux|x11)/.test(normalized)) {
        platform = 'linux';
    }

    let arch: TReleaseArch = 'unknown';
    if (/(arm64|aarch64|armv8|apple silicon)/.test(normalized)) {
        arch = 'arm64';
    } else if (/(x86_64|x64|amd64|wow64|win64)/.test(normalized)) {
        arch = 'x64';
    }
    // Safari's frozen macOS UA contains "Intel Mac OS X" on both Intel and
    // Apple Silicon hardware. Only UA-CH or an explicit architecture token is
    // safe enough for an automatic binary recommendation.

    return {
        platform,
        arch,
    };
}

export function buildClientProfile(
    userAgent: string,
    hintedPlatform: TReleasePlatform = 'unknown',
    hintedArch: TReleaseArch = 'unknown',
): IUserAgentProfile {
    const userAgentProfile = parseUserAgent(userAgent);
    const hasUnsupportedBrowserPlatform = userAgentProfile.platform === 'unknown'
        && isUnsupportedBrowserPlatform(userAgent);

    return {
        platform: hasUnsupportedBrowserPlatform
            ? 'unknown'
            : (hintedPlatform === 'unknown' ? userAgentProfile.platform : hintedPlatform),
        arch: hasUnsupportedBrowserPlatform
            ? 'unknown'
            : (hintedArch === 'unknown' ? userAgentProfile.arch : hintedArch),
    };
}

export function recommendInstaller(assets: IReleaseInstaller[], profile: IUserAgentProfile): IReleaseInstaller | null {
    const preferredAssets = assets.filter(asset => !asset.isLegacy);
    const candidatePool = preferredAssets.length ? preferredAssets : assets;

    if (!candidatePool.length || profile.platform === 'unknown') {
        return null;
    }

    const extensionPreference = PREFERRED_EXTENSION_ORDER[profile.platform];
    const platformScopedAssets = candidatePool.filter(asset => asset.platform === profile.platform);
    if (!platformScopedAssets.length) {
        return null;
    }

    const preferredScopedAssets = platformScopedAssets.filter(asset => extensionPreference.includes(asset.extension));
    const extensionScopedAssets = preferredScopedAssets.length ? preferredScopedAssets : platformScopedAssets;
    const architectureFiltered = extensionScopedAssets.filter(asset => isCompatibleArchitecture(asset.arch, profile.arch));
    if (!architectureFiltered.length) {
        // A wrong native binary is worse than no automatic recommendation.
        // Unknown variants remain visible for deliberate manual selection.
        return null;
    }
    const candidateAssets = architectureFiltered;

    const sorted = orderBy(candidateAssets, [
        asset => architectureRank(asset.arch, profile.arch),
        asset => extensionRank(asset.extension, extensionPreference),
        asset => knownPlatformRank(asset.platform),
        asset => asset.name,
    ], [
        'asc',
        'asc',
        'asc',
        'asc',
    ]);

    return sorted[0] ?? null;
}

function isCompatibleArchitecture(assetArch: TReleaseArch, profileArch: TReleaseArch) {
    if (profileArch === 'unknown') {
        return assetArch === 'universal';
    }

    return assetArch === profileArch || assetArch === 'universal';
}

export function normalizeInstallers(assets: IReleaseInstaller[]): IReleaseInstaller[] {
    const normalizedAssets = assets.map((asset) => {
        if (asset.platform === 'linux' && asset.extension === 'appimage' && asset.arch === 'unknown') {
            return {
                ...asset,
                arch: 'x64' as const,
            };
        }

        return asset;
    });

    const primaryAssets = normalizedAssets.filter(asset => !asset.isLegacy);
    const windowsExeArchs = new Set(uniq(primaryAssets
        .filter(asset => asset.platform === 'windows' && asset.extension === 'exe' && asset.arch !== 'unknown')
        .map(asset => asset.arch)));

    const hasArchSpecificWindowsBuilds = windowsExeArchs.has('x64') && windowsExeArchs.has('arm64');
    if (!hasArchSpecificWindowsBuilds) {
        return normalizedAssets;
    }

    return normalizedAssets.filter(asset => !(
        asset.platform === 'windows'
        && asset.extension === 'exe'
        && asset.arch === 'unknown'
        && !asset.isLegacy
    ));
}

function extensionRank(extension: string, preferenceOrder: string[]) {
    const index = preferenceOrder.indexOf(extension);
    if (index !== -1) {
        return index;
    }

    return preferenceOrder.length + 4;
}

function architectureRank(assetArch: TReleaseArch, profileArch: TReleaseArch) {
    if (profileArch === 'unknown') {
        if (assetArch === 'universal') {
            return 0;
        }

        if (assetArch === 'unknown') {
            return 1;
        }

        return 2;
    }

    if (assetArch === profileArch) {
        return 0;
    }

    if (assetArch === 'universal') {
        return 1;
    }

    if (assetArch === 'unknown') {
        return 2;
    }

    return 3;
}

function knownPlatformRank(platform: TReleasePlatform) {
    return platform === 'unknown' ? 1 : 0;
}

export function formatPlatform(platform: TReleasePlatform) {
    if (platform === 'macos') {
        return 'macOS';
    }

    if (platform === 'windows') {
        return 'Windows';
    }

    if (platform === 'linux') {
        return 'Linux';
    }

    return 'Unknown OS';
}

export function formatArch(arch: TReleaseArch) {
    if (arch === 'arm64') {
        return 'ARM64';
    }

    if (arch === 'x64') {
        return 'x64';
    }

    if (arch === 'universal') {
        return 'Universal';
    }

    return '';
}

export function formatExtension(extension: string) {
    return EXTENSION_LABEL[extension] ?? extension.toUpperCase();
}

export function formatInstallerLabel(asset: IReleaseInstaller) {
    const platform = formatPlatform(asset.platform);
    const arch = formatArch(asset.arch);
    const extension = formatExtension(asset.extension);

    if (arch) {
        return `${platform} ${arch} (${extension})`;
    }

    return `${platform} (${extension})`;
}

export function formatInstallerVariantLabel(asset: IReleaseInstaller) {
    const arch = formatArch(asset.arch);
    const extension = formatExtension(asset.extension);

    if (arch) {
        return `${arch} (${extension})`;
    }

    return extension;
}

export function formatInstallerArchLabel(asset: IReleaseInstaller) {
    if (asset.platform === 'macos') {
        if (asset.arch === 'arm64') {
            return 'Apple Silicon';
        }

        if (asset.arch === 'x64') {
            return 'Intel';
        }
    }

    return formatArch(asset.arch) || formatExtension(asset.extension);
}

export function formatInstallerMeta(asset: IReleaseInstaller) {
    const size = formatFileSize(asset.size);

    if (!formatArch(asset.arch)) {
        return size;
    }

    return `${formatExtension(asset.extension)} · ${size}`;
}

export function selectPreferredInstallers(assets: IReleaseInstaller[]): IReleaseInstaller[] {
    const first = assets[0];
    if (!first) {
        return assets;
    }

    const formatOrder = PREFERRED_EXTENSION_ORDER[first.platform];
    const assetsByArch = groupBy(assets, asset => asset.arch);

    const preferredInstallers: IReleaseInstaller[] = [];
    for (const archAssets of Object.values(assetsByArch)) {
        const preferred = orderBy(
            archAssets,
            [asset => extensionRank(asset.extension, formatOrder)],
            ['asc'],
        )[0];
        if (preferred) {
            preferredInstallers.push(preferred);
        }
    }

    return preferredInstallers;
}

export function compareInstallersForSelect(left: IReleaseInstaller, right: IReleaseInstaller) {
    const extensionPreference = PREFERRED_EXTENSION_ORDER[left.platform];
    const extensionDiff = extensionRank(left.extension, extensionPreference) - extensionRank(right.extension, extensionPreference);
    if (extensionDiff !== 0) {
        return extensionDiff;
    }

    const leftArchRank = INSTALLER_ARCH_ORDER[left.arch];
    const rightArchRank = INSTALLER_ARCH_ORDER[right.arch];
    const archDiff = leftArchRank - rightArchRank;
    if (archDiff !== 0) {
        return archDiff;
    }

    return left.name.localeCompare(right.name);
}

export function formatFileSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return 'Unknown size';
    }

    const units = [
        'B',
        'KB',
        'MB',
        'GB',
        'TB',
    ];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
    return `${rounded} ${units[unitIndex] ?? 'TB'}`;
}
