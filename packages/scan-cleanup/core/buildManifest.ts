/* eslint-disable custom/file-naming -- This module is the shared build-manifest boundary. */

import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {
    IScanCleanupWorkerPaths,
    TScanCleanupAssemblerBackend,
    TScanCleanupTransportMode,
} from '@evb/scan-cleanup/core/types';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_GIT_SHA_HEX_PATTERN,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
} from '@evb/scan-cleanup/core/provenanceStamp';
import type {TScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/provenanceStamp';
import {embeddedScanCleanupBuildGitSha} from '@evb/scan-cleanup/core/buildGitSha';
import {getErrorMessage} from '@contracts/getErrorMessage';

export async function buildScanCleanupStampBuildIds({
    paths,
    assemblerBackend,
    transportMode,
    hashNativeBinary,
}: {
    paths: IScanCleanupWorkerPaths;
    assemblerBackend: TScanCleanupAssemblerBackend;
    transportMode: TScanCleanupTransportMode;
    hashNativeBinary?: (path: string) => Promise<string>;
}): Promise<TScanCleanupStampBuildIds> {
    const gitSha = normalizeGitSha(embeddedScanCleanupBuildGitSha);
    const nativeBinarySha256s: Record<string, string> = {};
    const binaries: Array<[string, string | undefined]> = [
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
    for (const [
        role,
        path,
    ] of binaries) {
        if (path === undefined) continue;
        nativeBinarySha256s[role] = await hashBinaryOrBackendMarker(path, role, assemblerBackend, hashNativeBinary);
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
    if (/^__scan_cleanup_cli_[a-z_]+__$/u.test(path)) {
        return hashText(`${role}:${backend}`);
    }
    try {
        if (hashNativeBinary !== undefined) {
            return await hashNativeBinary(path);
        }
        return createHash('sha256').update(await readFile(path)).digest('hex');
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
