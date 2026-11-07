import type {
    IScanCleanupWorkerPaths,
    TScanCleanupAssemblerBackend,
    TScanCleanupTransportMode,
} from '@evb/scan-cleanup/core/types';
import {isScanCleanupCliFallbackSentinel} from '@evb/scan-cleanup/core/compactManifest';
import {
    composeScanCleanupStampBuildIds,
    hashScanCleanupBackendMarker,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {sha256ScanCleanupFile} from '@evb/scan-cleanup/core/sha256ScanCleanupFile';
import type {TScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/provenanceStamp';
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
            ?? (isScanCleanupCliFallbackSentinel(path)
                ? hashScanCleanupBackendMarker(role, assemblerBackend)
                : await hashNativeBinaryFile(path, role, hashNativeBinary));
    }
    return composeScanCleanupStampBuildIds({
        nativeBinarySha256s,
        assemblerBackend,
        transportMode,
    });
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
