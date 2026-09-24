import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    RELEASE_ARCHES,
    RELEASE_PLATFORMS,
} from '@contracts/release';
import type { IReleaseInstaller } from '@contracts/release';
import { requireIsoTimestamp } from '@contracts/timestamps';
import type {
    SetRequired,
    Simplify,
} from 'type-fest';
import {
    buildClientProfile,
    compareInstallersForSelect,
    detectArchitecture,
    detectPlatform,
    formatFileSize,
    formatInstallerArchLabel,
    formatInstallerVariantLabel,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    selectPreferredInstallers,
} from '@releaseSelection';

type TInstallerFixture = Simplify<SetRequired<Partial<IReleaseInstaller>, 'id' | 'name' | 'extension' | 'arch'>>;

function createInstaller(partial: TInstallerFixture): IReleaseInstaller {
    return {
        contentType: 'application/octet-stream',
        downloadUrl: `https://example.test/${partial.name}`,
        platform: 'macos',
        size: 1,
        updatedAt: requireIsoTimestamp('2026-01-01T00:00:00.000Z'),
        ...partial,
    };
}

describe('release selection', () => {
    it('executes the release contract platform and architecture definitions', () => {
        expect(RELEASE_PLATFORMS).toEqual([
            'macos',
            'windows',
            'linux',
            'unknown',
        ]);
        expect(RELEASE_ARCHES).toEqual([
            'arm64',
            'x64',
            'universal',
            'unknown',
        ]);
    });

    it('offers only the shipped installers from a release that still carries retired assets', () => {
        const v0_1_459Assets = [
            'diagnostics-evidence.json',
            'EVB-Viewer-0.1.459-amd64.deb',
            'EVB-Viewer-0.1.459-arm64-setup.exe',
            'EVB-Viewer-0.1.459-arm64-setup.exe.blockmap',
            'EVB-Viewer-0.1.459-arm64.AppImage',
            'EVB-Viewer-0.1.459-arm64.deb',
            'EVB-Viewer-0.1.459-arm64.dmg',
            'EVB-Viewer-0.1.459-arm64.dmg.blockmap',
            'EVB-Viewer-0.1.459-arm64.zip',
            'EVB-Viewer-0.1.459-arm64.zip.blockmap',
            'EVB-Viewer-0.1.459-win-arm64-provenance.json',
            'EVB-Viewer-0.1.459-x64-setup.exe',
            'EVB-Viewer-0.1.459-x64.zip',
            'EVB-Viewer-0.1.459-x86_64.AppImage',
            'EVB-Viewer-0.1.459-win7-legacy-x64-setup.exe',
            'latest-mac.yml',
            'latest-win-x64.yml',
            'SHA256SUMS',
        ];

        expect(v0_1_459Assets.filter(isInstallerAsset).map(name => [
            name,
            detectPlatform(name),
            detectArchitecture(name),
        ])).toEqual([
            [
                'EVB-Viewer-0.1.459-amd64.deb',
                'linux',
                'x64',
            ],
            [
                'EVB-Viewer-0.1.459-arm64-setup.exe',
                'windows',
                'arm64',
            ],
            [
                'EVB-Viewer-0.1.459-arm64.deb',
                'linux',
                'arm64',
            ],
            [
                'EVB-Viewer-0.1.459-arm64.dmg',
                'macos',
                'arm64',
            ],
            [
                'EVB-Viewer-0.1.459-x64-setup.exe',
                'windows',
                'x64',
            ],
        ]);
    });

    it('normalizes Chromium UA-CH architecture hints', () => {
        expect(parseArchitectureHint('arm')).toBe('arm64');
        expect(parseArchitectureHint('x86')).toBe('x64');
        expect(parseArchitectureHint('arm64')).toBe('arm64');
        expect(parseArchitectureHint('x86_64')).toBe('x64');
    });

    it('parses release asset extensions and filters metadata sidecars', () => {
        expect(getAssetExtension('EVB-Viewer-linux-x64.tar.gz')).toBe('tar.gz');
        expect(getAssetExtension('latest.yml')).toBe('yml');
        expect(isInstallerAsset('EVB-Viewer-mac-arm64.dmg')).toBe(true);
        expect(isInstallerAsset('EVB-Viewer-win-x64.exe.blockmap')).toBe(false);
        expect(isInstallerAsset('latest-mac.yml')).toBe(false);
        expect(isInstallerAsset('EVB-Viewer-linux-x64.tar.gz.sha256')).toBe(false);
    });

    it('detects platforms and architectures from representative asset names', () => {
        expect(detectPlatform('EVB-Viewer-darwin-arm64.dmg')).toBe('macos');
        expect(detectPlatform('EVB-Viewer-win-x64.exe')).toBe('windows');
        expect(detectPlatform('EVB-Viewer-portable.zip')).toBe('unknown');
        expect(detectArchitecture('EVB-Viewer-all.dmg')).toBe('universal');
        expect(detectArchitecture('EVB-Viewer-aarch64.deb')).toBe('arm64');
        expect(detectArchitecture('EVB-Viewer-amd64.deb')).toBe('x64');
    });

    it('parses platform hints and common user agents', () => {
        expect(parsePlatformHint('macOS')).toBe('macos');
        expect(parsePlatformHint('Windows')).toBe('windows');
        expect(parsePlatformHint('Linux x86_64')).toBe('linux');
        expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toEqual({
            platform: 'macos',
            arch: 'unknown',
        });
        expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toEqual({
            platform: 'windows',
            arch: 'x64',
        });
        expect(parseUserAgent('Mozilla/5.0 (X11; Linux aarch64)')).toEqual({
            platform: 'linux',
            arch: 'arm64',
        });
    });

    it.each([
        [
            'iPhone',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        ],
        [
            'iPad desktop mode',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148',
        ],
        [
            'Android',
            'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro)',
        ],
        [
            'ChromeOS',
            'Mozilla/5.0 (X11; CrOS x86_64 16093.68.0)',
        ],
    ])('does not classify %s as a desktop installer platform', (_label, userAgent) => {
        expect(parseUserAgent(userAgent)).toEqual({
            platform: 'unknown',
            arch: 'unknown',
        });
        expect(buildClientProfile(userAgent, 'macos', 'arm64')).toEqual({
            platform: 'unknown',
            arch: 'unknown',
        });
    });

    it('does not parse mobile and ChromeOS client hints as desktop platforms', () => {
        expect(parsePlatformHint('iOS')).toBe('unknown');
        expect(parsePlatformHint('iPadOS')).toBe('unknown');
        expect(parsePlatformHint('Android')).toBe('unknown');
        expect(parsePlatformHint('Chrome OS')).toBe('unknown');
    });

    it('does not treat the frozen Intel Mac compatibility token as a hardware signal', () => {
        const intelMacUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

        expect(buildClientProfile(intelMacUserAgent)).toEqual({
            platform: 'macos',
            arch: 'unknown',
        });
        expect(buildClientProfile(intelMacUserAgent, 'macos', 'x64')).toEqual({
            platform: 'macos',
            arch: 'x64',
        });
        expect(buildClientProfile(intelMacUserAgent, 'macos', 'arm64')).toEqual({
            platform: 'macos',
            arch: 'arm64',
        });
    });

    it('does not mistake unrelated platform substrings for mobile operating systems', () => {
        expect(parsePlatformHint('Microsoft Windows')).toBe('windows');
        expect(buildClientProfile('Mozilla/5.0 (Windows NT 10.0) Microsoft Edge', 'windows', 'x64')).toEqual({
            platform: 'windows',
            arch: 'x64',
        });
        expect(buildClientProfile('Studios Linux x86_64')).toEqual({
            platform: 'linux',
            arch: 'x64',
        });
    });

    it('does not guess that an unlabelled generic ZIP is a macOS installer', () => {
        const [installer] = normalizeInstallers([createInstaller({
            arch: 'unknown',
            extension: 'zip',
            id: 1,
            name: 'EVB-Viewer-portable.zip',
            platform: 'unknown',
        })]);

        expect(installer?.platform).toBe('unknown');
    });

    it('filters unknown Windows exe assets only when arch-specific exes are present', () => {
        const installers = normalizeInstallers([
            createInstaller({
                arch: 'x64',
                extension: 'exe',
                id: 1,
                name: 'EVB-Viewer-win-x64.exe',
                platform: 'windows',
            }),
            createInstaller({
                arch: 'arm64',
                extension: 'exe',
                id: 2,
                name: 'EVB-Viewer-win-arm64.exe',
                platform: 'windows',
            }),
            createInstaller({
                arch: 'unknown',
                extension: 'exe',
                id: 3,
                name: 'EVB-Viewer-win.exe',
                platform: 'windows',
            }),
        ]);

        expect(installers.map(installer => installer.name)).toEqual([
            'EVB-Viewer-win-x64.exe',
            'EVB-Viewer-win-arm64.exe',
        ]);
    });

    it('requires a known compatible desktop platform and architecture', () => {
        const installers = [
            createInstaller({
                arch: 'arm64',
                extension: 'dmg',
                id: 1,
                name: 'EVB-Viewer-mac-arm64.dmg',
            }),
            createInstaller({
                arch: 'x64',
                extension: 'exe',
                id: 2,
                name: 'EVB-Viewer-win-x64.exe',
                platform: 'windows',
            }),
        ];

        expect(recommendInstaller(installers, {
            platform: 'unknown',
            arch: 'unknown',
        })).toBeNull();
        expect(recommendInstaller(installers, {
            platform: 'linux',
            arch: 'x64',
        })).toBeNull();
        expect(recommendInstaller(installers, {
            platform: 'macos',
            arch: 'x64',
        })).toBeNull();
        expect(recommendInstaller(installers, {
            platform: 'windows',
            arch: 'unknown',
        })).toBeNull();

        const universalMac = createInstaller({
            arch: 'universal',
            extension: 'dmg',
            id: 3,
            name: 'EVB-Viewer-mac-universal.dmg',
        });
        expect(recommendInstaller([universalMac], {
            platform: 'macos',
            arch: 'unknown',
        })).toBe(universalMac);

        const unknownWindows = createInstaller({
            arch: 'unknown',
            extension: 'exe',
            id: 4,
            name: 'EVB-Viewer-win.exe',
            platform: 'windows',
        });
        expect(recommendInstaller([unknownWindows], {
            platform: 'windows',
            arch: 'x64',
        })).toBeNull();
    });

    it('formats installer arch and variant labels for Apple Silicon and unknown arch fallbacks', () => {
        expect(formatInstallerArchLabel(createInstaller({
            arch: 'arm64',
            extension: 'dmg',
            id: 2,
            name: 'EVB-Viewer-mac-arm64.dmg',
        }))).toBe('Apple Silicon');
        expect(formatInstallerVariantLabel(createInstaller({
            arch: 'unknown',
            extension: 'zip',
            id: 3,
            name: 'EVB-Viewer-mac.zip',
        }))).toBe('ZIP');
    });

    it('formats file sizes at byte and unit boundaries', () => {
        expect(formatFileSize(0)).toBe('Unknown size');
        expect(formatFileSize(Number.NaN)).toBe('Unknown size');
        expect(formatFileSize(1)).toBe('1.0 B');
        expect(formatFileSize(1024)).toBe('1.0 KB');
        expect(formatFileSize(10 * 1024)).toBe('10 KB');
        expect(formatFileSize(1024 ** 2)).toBe('1.0 MB');
        expect(formatFileSize(1024 ** 3)).toBe('1.0 GB');
        expect(formatFileSize(1024 ** 4)).toBe('1.0 TB');
    });

    it('selects one preferred installer per effective architecture', () => {
        const preferred = selectPreferredInstallers([
            createInstaller({
                arch: 'x64',
                extension: 'zip',
                id: 1,
                name: 'EVB-Viewer-mac-x64.zip',
            }),
            createInstaller({
                arch: 'x64',
                extension: 'dmg',
                id: 2,
                name: 'EVB-Viewer-mac-x64.dmg',
            }),
            createInstaller({
                arch: 'arm64',
                extension: 'pkg',
                id: 3,
                name: 'EVB-Viewer-mac-arm64.pkg',
            }),
        ]);

        expect(preferred.map(installer => installer.name)).toEqual([
            'EVB-Viewer-mac-x64.dmg',
            'EVB-Viewer-mac-arm64.pkg',
        ]);
    });

    it('orders installers for select menus by extension preference, arch, and name', () => {
        const sorted = [
            createInstaller({
                arch: 'arm64',
                extension: 'pkg',
                id: 1,
                name: 'B.pkg',
            }),
            createInstaller({
                arch: 'arm64',
                extension: 'dmg',
                id: 2,
                name: 'B.dmg',
            }),
            createInstaller({
                arch: 'x64',
                extension: 'dmg',
                id: 3,
                name: 'A.dmg',
            }),
            createInstaller({
                arch: 'x64',
                extension: 'dmg',
                id: 4,
                name: 'B.dmg',
            }),
        ].toSorted(compareInstallersForSelect);

        expect(sorted.map(installer => installer.name)).toEqual([
            'A.dmg',
            'B.dmg',
            'B.dmg',
            'B.pkg',
        ]);
        expect(sorted.map(installer => installer.arch)).toEqual([
            'x64',
            'x64',
            'arm64',
            'arm64',
        ]);
    });
});
