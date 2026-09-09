import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    mkdir,
    open,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
    NATIVE_RESOURCE_PLATFORM_ARCHES,
    NATIVE_TOOL_RESOURCE_FAMILY_IDS,
    isNativeResourceArch,
    isNativeResourcePlatform,
    type INativeResourceTarget,
    type TNativeToolResourceFamilyId,
} from '@scripts/nativeResourceManifest';

export type TRuntimeBinaryArchiveKind = 'tar.gz' | 'zip';

export interface IRuntimeBinaryManifestEntry {
    archiveKind: TRuntimeBinaryArchiveKind;
    archiveBytes: number;
    archiveSha256: string;
    archiveUrl: string;
    executableEntry: string;
    familyId: TNativeToolResourceFamilyId;
    target: INativeResourceTarget;
}

export interface IRuntimeBinaryManifest {
    entries: readonly IRuntimeBinaryManifestEntry[];
    manifestSha256: string;
}

export interface IRuntimeBinaryArchiveResult {
    archivePath: string;
    entry: IRuntimeBinaryManifestEntry;
}

export type TRuntimeBinaryArchiveTransport = (
    url: string,
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_RUNTIME_BINARY_ARCHIVE_BYTES = 512 * 1024 * 1024;

function assertSha256(value: string, label: string) {
    if (!SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest.`);
    }
}

function assertFamilyId(value: TNativeToolResourceFamilyId) {
    if (
        !NATIVE_TOOL_RESOURCE_FAMILY_IDS.includes(value)
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    ) {
        throw new Error(`Runtime family id is not a safe identifier: ${value}`);
    }
}

function compareCodeUnits(left: string, right: string) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalManifestEntries(entries: readonly IRuntimeBinaryManifestEntry[]) {
    return JSON.stringify([...entries]
        .sort((left, right) => compareCodeUnits(
            `${left.familyId}\0${left.target.platformArch}`,
            `${right.familyId}\0${right.target.platformArch}`,
        ))
        .map(entry => ({
            archiveKind: entry.archiveKind,
            archiveBytes: entry.archiveBytes,
            archiveSha256: entry.archiveSha256,
            archiveUrl: entry.archiveUrl,
            executableEntry: entry.executableEntry,
            familyId: entry.familyId,
            target: {
                arch: entry.target.arch,
                exeSuffix: entry.target.exeSuffix,
                platform: entry.target.platform,
                platformArch: entry.target.platformArch,
            },
        })));
}

export function computeRuntimeBinaryManifestSha256(
    entries: readonly IRuntimeBinaryManifestEntry[],
) {
    return createHash('sha256').update(canonicalManifestEntries(entries), 'utf8').digest('hex');
}

function assertSafeExecutableEntry(entry: string) {
    const normalized = entry.replaceAll('\\', '/');
    if (
        normalized.length === 0
        || normalized.startsWith('/')
        || normalized.includes('\0')
        || /^[a-z]:/iu.test(normalized)
        || normalized.split('/').some(segment => segment === '..' || segment.length === 0)
    ) {
        throw new Error(`Runtime executable entry is not a safe relative path: ${entry}`);
    }
}

function assertTarget(target: INativeResourceTarget) {
    if (!isNativeResourcePlatform(target.platform) || !isNativeResourceArch(target.arch)) {
        throw new Error(`Runtime target ${target.platformArch} is not a supported native resource target.`);
    }
    if (!NATIVE_RESOURCE_PLATFORM_ARCHES.includes(target.platformArch)) {
        throw new Error(`Runtime target ${target.platformArch} is not a supported native resource target.`);
    }
    const expectedPlatformArch = `${target.platform}-${target.arch}`;
    if (target.platformArch !== expectedPlatformArch) {
        throw new Error(`Runtime target ${target.platformArch} does not match its platform and architecture.`);
    }
    const expectedExeSuffix = target.platform === 'win32' ? '.exe' : '';
    if (target.exeSuffix !== expectedExeSuffix) {
        throw new Error(`Runtime target ${target.platformArch} has an invalid executable suffix.`);
    }
}

export function validateRuntimeBinaryManifest(manifest: IRuntimeBinaryManifest) {
    assertSha256(manifest.manifestSha256, 'Runtime manifest');
    if (manifest.entries.length === 0) {
        throw new Error('Runtime manifest must contain at least one target.');
    }

    const targetIds = new Set<string>();
    for (const entry of manifest.entries) {
        if (entry.archiveKind !== 'tar.gz' && entry.archiveKind !== 'zip') {
            throw new Error('Runtime archive kind is unsupported.');
        }
        assertTarget(entry.target);
        if (
            !Number.isSafeInteger(entry.archiveBytes)
            || entry.archiveBytes <= 0
            || entry.archiveBytes > MAX_RUNTIME_BINARY_ARCHIVE_BYTES
        ) {
            throw new Error(
                `Runtime archive ${entry.familyId}:${entry.target.platformArch} has an invalid byte length.`,
            );
        }
        assertSha256(entry.archiveSha256, `Runtime archive ${entry.target.platformArch}`);
        assertSafeExecutableEntry(entry.executableEntry);
        assertFamilyId(entry.familyId);
        const url = new URL(entry.archiveUrl);
        if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
            throw new Error(`Runtime archive URL is not a credential-free HTTPS URL: ${entry.archiveUrl}`);
        }
        const targetId = `${entry.familyId}:${entry.target.platformArch}`;
        if (targetIds.has(targetId)) {
            throw new Error(`Runtime manifest contains duplicate family target ${targetId}.`);
        }
        targetIds.add(targetId);
    }

    const computedSha256 = computeRuntimeBinaryManifestSha256(manifest.entries);
    if (computedSha256 !== manifest.manifestSha256) {
        throw new Error(
            `Runtime manifest SHA-256 ${manifest.manifestSha256} does not match ${computedSha256}.`,
        );
    }
    return manifest;
}

function archivePathFor(
    cacheDirectory: string,
    manifest: IRuntimeBinaryManifest,
    entry: IRuntimeBinaryManifestEntry,
) {
    return path.join(
        cacheDirectory,
        `${entry.familyId}-${entry.target.platformArch}-${manifest.manifestSha256}-${entry.archiveSha256}.${entry.archiveKind.replace('.', '-')}`,
    );
}

async function sha256File(filePath: string) {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath) as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
        digest.update(chunk);
    }
    return digest.digest('hex');
}

async function removePartialDownload(partPath: string) {
    await rm(partPath, {force: true}).catch(() => undefined);
}

export async function fetchVerifiedRuntimeArchive({
    cacheDirectory,
    familyId,
    manifest,
    target,
    transport,
}: {
    cacheDirectory: string;
    familyId: TNativeToolResourceFamilyId;
    manifest: IRuntimeBinaryManifest;
    target: INativeResourceTarget;
    transport: TRuntimeBinaryArchiveTransport;
}): Promise<IRuntimeBinaryArchiveResult> {
    validateRuntimeBinaryManifest(manifest);
    const entry = manifest.entries.find(candidate => (
        candidate.familyId === familyId && candidate.target.platformArch === target.platformArch
    ));
    if (!entry) {
        throw new Error(`Runtime manifest has no family target ${familyId}:${target.platformArch}.`);
    }
    assertTarget(target);
    if (
        entry.target.platform !== target.platform
        || entry.target.arch !== target.arch
        || entry.target.exeSuffix !== target.exeSuffix
        || entry.target.platformArch !== target.platformArch
    ) {
        throw new Error(`Runtime target ${target.platformArch} does not match the manifest target.`);
    }

    await mkdir(cacheDirectory, {recursive: true});
    const archivePath = archivePathFor(cacheDirectory, manifest, entry);
    try {
        const cacheStats = await stat(archivePath);
        if (
            cacheStats.size === entry.archiveBytes
            && await sha256File(archivePath) === entry.archiveSha256
        ) {
            return {
                archivePath,
                entry,
            };
        }
        await rm(archivePath, {force: true});
    } catch {
        await rm(archivePath, {force: true}).catch(() => undefined);
    }

    const partialPath = `${archivePath}.part-${randomUUID()}`;
    const digest = createHash('sha256');
    let receivedBytes = 0;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        const chunks = await transport(entry.archiveUrl);
        handle = await open(partialPath, 'wx', 0o600);
        for await (const chunk of chunks) {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > MAX_RUNTIME_BINARY_ARCHIVE_BYTES) {
                throw new Error('Runtime archive exceeded the maximum allowed size.');
            }
            if (receivedBytes > entry.archiveBytes) {
                throw new Error(
                    `Runtime archive ${entry.familyId}:${entry.target.platformArch} exceeded its expected ${entry.archiveBytes}-byte length.`,
                );
            }
            digest.update(chunk);
            const writeResult = await handle.write(chunk);
            if (writeResult.bytesWritten !== chunk.byteLength) {
                throw new Error('Runtime archive partial write was detected before verification.');
            }
        }
        await handle.sync();
        if (receivedBytes !== entry.archiveBytes) {
            throw new Error(
                `Runtime archive ${entry.familyId}:${entry.target.platformArch} has ${receivedBytes} bytes, expected ${entry.archiveBytes}.`,
            );
        }
        const actualSha256 = digest.digest('hex');
        if (actualSha256 !== entry.archiveSha256) {
            throw new Error(
                `Runtime archive ${entry.target.platformArch} SHA-256 ${actualSha256} does not match ${entry.archiveSha256}.`,
            );
        }
        await handle.close();
        handle = null;
        await rename(partialPath, archivePath);
        return {
            archivePath,
            entry,
        };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await removePartialDownload(partialPath);
        throw error;
    }
}
