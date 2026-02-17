export type ReleasePlatform = 'macos' | 'windows' | 'linux' | 'unknown';
export type ReleaseArch = 'arm64' | 'x64' | 'universal' | 'unknown';

export interface ReleaseInstaller {
    id: number
    name: string
    downloadUrl: string
    size: number
    updatedAt: string
    contentType: string
    extension: string
    platform: ReleasePlatform
    arch: ReleaseArch
}

export interface ReleaseSummary {
    tag: string
    name: string
    publishedAt: string
    htmlUrl: string
}

export interface UserAgentProfile {
    platform: ReleasePlatform
    arch: ReleaseArch
}

export interface LatestReleaseResponse {
    release: ReleaseSummary
    assets: ReleaseInstaller[]
    recommendation: {
        platform: ReleasePlatform
        arch: ReleaseArch
        assetId: number | null
    }
}

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

const PREFERRED_EXTENSION_ORDER: Record<ReleasePlatform, string[]> = {
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
    'appimage': 'AppImage',
    'deb': 'DEB',
    'dmg': 'DMG',
    'exe': 'EXE',
    'msi': 'MSI',
    'pkg': 'PKG',
    'rpm': 'RPM',
    'tar.gz': 'TAR.GZ',
    'zip': 'ZIP',
};

export function getAssetExtension(assetName: string): string {
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

export function isInstallerAsset(assetName: string): boolean {
    const lowerName = assetName.toLowerCase();

    if (NON_INSTALLER_SUFFIXES.some(suffix => lowerName.endsWith(suffix))) {
        return false;
    }

    if (lowerName.includes('latest-mac') || lowerName.includes('latest-linux') || lowerName.includes('latest.yml')) {
        return false;
    }

    return INSTALLER_EXTENSIONS.has(getAssetExtension(assetName));
}

export function detectPlatform(assetName: string): ReleasePlatform {
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

    return 'unknown';
}

export function detectArchitecture(assetName: string): ReleaseArch {
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

export function parsePlatformHint(hint: string | null | undefined): ReleasePlatform {
    const normalizedHint = (hint || '').toLowerCase();

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

export function parseArchitectureHint(hint: string | null | undefined): ReleaseArch {
    const normalizedHint = (hint || '').toLowerCase();

    if (normalizedHint.includes('arm64') || normalizedHint.includes('aarch64')) {
        return 'arm64';
    }

    if (normalizedHint.includes('x86_64') || normalizedHint.includes('x64') || normalizedHint.includes('amd64')) {
        return 'x64';
    }

    return 'unknown';
}

export function parseUserAgent(userAgent: string, platformHint = ''): UserAgentProfile {
    const normalized = `${platformHint} ${userAgent}`.toLowerCase();

    let platform: ReleasePlatform = 'unknown';
    if (/(macintosh|mac os x|darwin)/.test(normalized)) {
        platform = 'macos';
    } else if (/(windows|win32|win64)/.test(normalized)) {
        platform = 'windows';
    } else if (/(linux|x11)/.test(normalized)) {
        platform = 'linux';
    }

    let arch: ReleaseArch = 'unknown';
    if (/(arm64|aarch64|armv8|apple silicon)/.test(normalized)) {
        arch = 'arm64';
    } else if (/(x86_64|x64|amd64|wow64|intel|win64)/.test(normalized)) {
        arch = 'x64';
    }

    return {
        platform,
        arch, 
    };
}

export function recommendInstaller(assets: ReleaseInstaller[], profile: UserAgentProfile): ReleaseInstaller | null {
    if (!assets.length) {
        return null;
    }

    const extensionPreference = PREFERRED_EXTENSION_ORDER[profile.platform] || PREFERRED_EXTENSION_ORDER.unknown;
    const platformFiltered = assets.filter(asset => profile.platform !== 'unknown' && asset.platform === profile.platform);
    const platformScopedAssets = platformFiltered.length ? platformFiltered : assets;

    const preferredScopedAssets = platformScopedAssets.filter(asset => extensionPreference.includes(asset.extension));
    const candidateAssets = preferredScopedAssets.length ? preferredScopedAssets : platformScopedAssets;

    const sorted = [...candidateAssets].sort((left, right) => {
        const extensionDiff = extensionRank(left.extension, extensionPreference) - extensionRank(right.extension, extensionPreference);
        if (extensionDiff !== 0) {
            return extensionDiff;
        }

        const archDiff = architectureRank(left.arch, profile.arch) - architectureRank(right.arch, profile.arch);
        if (archDiff !== 0) {
            return archDiff;
        }

        const knownPlatformDiff = knownPlatformRank(left.platform) - knownPlatformRank(right.platform);
        if (knownPlatformDiff !== 0) {
            return knownPlatformDiff;
        }

        return left.name.localeCompare(right.name);
    });

    return sorted[0] || null;
}

function extensionRank(extension: string, preferenceOrder: string[]): number {
    const index = preferenceOrder.indexOf(extension);
    if (index !== -1) {
        return index;
    }

    return preferenceOrder.length + 4;
}

function architectureRank(assetArch: ReleaseArch, profileArch: ReleaseArch): number {
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

function knownPlatformRank(platform: ReleasePlatform): number {
    return platform === 'unknown' ? 1 : 0;
}

export function formatPlatform(platform: ReleasePlatform): string {
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

export function formatArch(arch: ReleaseArch): string {
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

export function formatExtension(extension: string): string {
    return EXTENSION_LABEL[extension] || extension.toUpperCase();
}

export function formatInstallerLabel(asset: ReleaseInstaller): string {
    const platform = formatPlatform(asset.platform);
    const arch = formatArch(asset.arch);
    const extension = formatExtension(asset.extension);

    if (arch) {
        return `${platform} ${arch} (${extension})`;
    }

    return `${platform} (${extension})`;
}

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return 'Unknown size';
    }

    const units = [
        'B',
        'KB',
        'MB',
        'GB',
    ];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
    return `${rounded} ${units[unitIndex]}`;
}
