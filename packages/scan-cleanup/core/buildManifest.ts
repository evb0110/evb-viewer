

import {createHash} from 'node:crypto';
import type {
    IScanCleanupWorkerPaths,
    TScanCleanupAssemblerBackend,
    TScanCleanupTransportMode,
} from '@evb/scan-cleanup/core/types';
import {isScanCleanupCliFallbackSentinel} from '@evb/scan-cleanup/core/compactManifest';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_GIT_SHA_HEX_PATTERN,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,sha256ScanCleanupFile,
} from '@evb/scan-cleanup/core/provenanceStamp';
import type {TScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/provenanceStamp';
import {embeddedScanCleanupBuildGitSha} from '@evb/scan-cleanup/core/buildGitSha';
import {getErrorMessage} from '@contracts/getErrorMessage';

export async function buildScanCleanupStampBuildIds({
    paths,
    assemblerBackend,
    transportMode,
    hashNativeBinary,
    reusableNativeBinarySha256s,
}: {
    paths: IScanCleanupWorkerPaths;
    assemblerBackend: TScanCleanupAssemblerBackend;
    transportMode: TScanCleanupTransportMode;
    hashNativeBinary?: (path: string) => Promise<string>;
    reusableNativeBinarySha256s?: Readonly<Record<string, string>>;
}): Promise<TScanCleanupStampBuildIds> {
    const gitSha = normalizeGitSha(embeddedScanCleanupBuildGitSha);
    const nativeBinarySha256s: Record<string, string> = {};
    for (const [
        role,
        path,
    ] of scanCleanupNativeBinaryEntries(paths)) {
        if (path === undefined) continue;
        const reusableDigest = isScanCleanupCliFallbackSentinel(path)
            ? undefined
            : reusableNativeBinarySha256s?.[role];
        nativeBinarySha256s[role] = reusableDigest
            ?? await hashBinaryOrBackendMarker(path, role, assemblerBackend, hashNativeBinary);
    }
    if (Object.keys(nativeBinarySha256s).length === 0) {
        nativeBinarySha256s.assembler = hashText(`assembler:${assemblerBackend}`);
    }
    const legacyBuildIds = {
        coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
        nativeBinarySha256s,
        assemblerBackend,
        transportMode,
    };
    if (gitSha === null) {
        return {
            ...legacyBuildIds,
            coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
        };
    }
    return {
        ...legacyBuildIds,
        coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
        gitSha,
    };
}

export async function hashScanCleanupNativeBinarySha256s({
    paths,
    hashNativeBinary,
}: {
    paths: IScanCleanupWorkerPaths;
    hashNativeBinary?: (path: string) => Promise<string>;
}): Promise<Record<string, string>> {
    const nativeBinarySha256s: Record<string, string> = {};
    for (const [
        role,
        path,
    ] of scanCleanupNativeBinaryEntries(paths)) {
        if (path === undefined || isScanCleanupCliFallbackSentinel(path)) continue;
        nativeBinarySha256s[role] = await hashNativeBinaryFile(path, role, hashNativeBinary);
    }
    return nativeBinarySha256s;
}

function scanCleanupNativeBinaryEntries(paths: IScanCleanupWorkerPaths): Array<[string, string | undefined]> {
    return [
        [
            'scanCleanup',
            paths.scanCleanupBinary,
        ],
        [
            'pdfImageCombine',
            paths.pdfImageCombineBinary,
        ],
        [
            'pdfPageOps',
            paths.pdfPageOpsBinary,
        ],
    ];
}

function normalizeGitSha(value: string | null | undefined) {
    const sha = value?.trim().toLowerCase() ?? '';
    return SCAN_CLEANUP_GIT_SHA_HEX_PATTERN.test(sha) ? sha : null;
}

async function hashBinaryOrBackendMarker(
    path: string,
    role: string,
    backend: TScanCleanupAssemblerBackend,
    hashNativeBinary?: (path: string) => Promise<string>,
) {
    if (isScanCleanupCliFallbackSentinel(path)) {
        return hashText(`${role}:${backend}`);
    }
    return hashNativeBinaryFile(path, role, hashNativeBinary);
}

async function hashNativeBinaryFile(
    path: string,
    role: string,
    hashNativeBinary?: (path: string) => Promise<string>,
) {
    try {
        if (hashNativeBinary !== undefined) {
            return await hashNativeBinary(path);
        }
        return await sha256ScanCleanupFile(path);
    } catch (error) {
        throw new Error(
            `Provenance stamp requires a readable ${role} binary at ${path}: `
            + getErrorMessage(error),
        );
    }
}

function hashText(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
