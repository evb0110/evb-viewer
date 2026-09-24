import type { LiteralUnion } from 'type-fest';
import type {TIsoTimestamp} from '@contracts/timestamps';

export const RELEASE_PLATFORMS = [
    'macos',
    'windows',
    'linux',
    'unknown',
] as const;
export const RELEASE_ARCHES = [
    'arm64',
    'x64',
    'universal',
    'unknown',
] as const;

export type TReleasePlatform = typeof RELEASE_PLATFORMS[number];
export type TReleaseArch = typeof RELEASE_ARCHES[number];
export type TReleaseInstallerExtension = LiteralUnion<
    'deb' | 'dmg' | 'exe',
    string
>;

export interface IReleaseInstaller {
    id: number;
    name: string;
    downloadUrl: string;
    mirrorDownloadUrl?: string;
    size: number;
    // Release manifests are consumed as an external ISO timestamp wire format.
    updatedAt: TIsoTimestamp;
    contentType: string;
    extension: TReleaseInstallerExtension;
    platform: TReleasePlatform;
    arch: TReleaseArch;
}

export interface IReleaseSummary {
    tag: string;
    name: string;
    // Release manifests are consumed as an external ISO timestamp wire format.
    publishedAt: TIsoTimestamp;
    htmlUrl: string;
}

export interface IUserAgentProfile {
    platform: TReleasePlatform;
    arch: TReleaseArch;
}

export interface ILatestReleaseResponse {
    release: IReleaseSummary;
    assets: IReleaseInstaller[];
    recommendation: {
        platform: TReleasePlatform;
        arch: TReleaseArch;
        assetId: number | null;
    };
}
