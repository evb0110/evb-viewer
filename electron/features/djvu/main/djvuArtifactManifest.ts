import { getErrorMessage } from '@electron/utils/error';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    statfs,
    writeFile,
} from 'node:fs/promises';
import {
    isAbsolute,
    join,
    relative,
    resolve,
} from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';
import {getAppTempDir} from '@electron/utils/appTempDir';

export type TDjvuArtifactRangeStatus = 'pending' | 'running' | 'verified' | 'failed';

export interface IDjvuArtifactRange {
    startPage: number;
    endPage: number;
    outputPath: string;
    status: TDjvuArtifactRangeStatus;
    size?: number;
    sha256?: string;
    accountedSize?: number;
    error?: string | undefined;
}

export interface IDjvuSourceIdentity {
    sourceSha256: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

interface IDjvuArtifactManifest {
    version: 2;
    fingerprint: string;
    sourcePath: string;
    sourceSha256: string;
    createdAtMs: number;
    updatedAtMs: number;
    ranges: IDjvuArtifactRange[];
}

export interface IDjvuArtifactJob {
    directory: string;
    manifestPath: string;
    manifest: IDjvuArtifactManifest;
    sourceIdentity: IDjvuSourceIdentity;
    maxTotalBytes: number;
    close(): Promise<void>;
    cleanup?(): Promise<void>;
    updateRange(
        index: number,
        update: Partial<IDjvuArtifactRange>,
        verification?: {additionalArtifacts?: readonly IDjvuArtifactVerification[];},
    ): Promise<void>;
}

export interface IDjvuArtifactVerification {
    path: string;
    size: number;
    sha256: string;
}

class DjvuDiskQuotaError extends Error {
    readonly subsystem = 'djvu';

    constructor(message: string) {
        super(`DjVu disk quota exceeded: ${message}`);
        this.name = 'DjvuDiskQuotaError';
    }
}

const STALE_JOB_MS = 7 * 24 * 60 * 60 * 1_000;
const DJVU_ARTIFACT_FREE_SPACE_RESERVE_BYTES = 128 * 1024 * 1024;
// The walk also sizes the in-progress conversion output, so it cannot be replaced by the
// manifest's verified-artifact totals; poll rarely enough to stay off the conversion's I/O path.
const DJVU_QUOTA_MONITOR_INTERVAL_MS = 2_000;
const activeFingerprintTails = new Map<string, Promise<void>>();

async function ensureJobRoot() {
    const jobRoot = join(getAppTempDir(), 'djvu-artifact-jobs');
    await mkdir(jobRoot, {
        mode: 0o700,
        recursive: true,
    });
    const info = await lstat(jobRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`DjVu artifact root must be a private directory: ${jobRoot}`);
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new Error(`DjVu artifact root is not owned by the current user: ${jobRoot}`);
    }
    await chmod(jobRoot, 0o700);
    return jobRoot;
}

function isPathInside(path: string, parent: string) {
    const pathRelativeToParent = relative(resolve(parent), resolve(path));
    return pathRelativeToParent.length > 0
        && !pathRelativeToParent.startsWith('..')
        && !isAbsolute(pathRelativeToParent);
}

async function measurePathBytes(path: string): Promise<number> {
    const info = await lstat(path).catch(() => null);
    if (!info) {
        return 0;
    }
    if (!info.isDirectory()) {
        return info.size;
    }
    const entries = await readdir(path, {withFileTypes: true});
    const sizes = await Promise.all(entries.map(entry => measurePathBytes(join(path, entry.name))));
    return sizes.reduce((total, size) => total + size, 0);
}

function withoutNestedPaths(paths: readonly string[]) {
    const normalized = [...new Set(paths.map(path => resolve(path)))];
    return normalized.filter((path, index) => !normalized.some((candidate, candidateIndex) => (
        candidateIndex !== index && isPathInside(path, candidate)
    )));
}

export async function createDjvuDiskQuotaMonitor(options: {
    paths: readonly string[];
    fileSystemPath: string;
    /** Optional fixed test/job ceiling. Production callers use free space minus the reserve. */
    maxTotalBytes?: number;
    signal?: AbortSignal;
    intervalMs?: number;
    freeSpaceReserveBytes?: number;
    readAvailableBytesForTests?: () => Promise<number>;
}) {
    const controller = new AbortController();
    const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            controller.signal,
        ])
        : controller.signal;
    const monitoredPaths = withoutNestedPaths(options.paths);
    const reserveBytes = options.freeSpaceReserveBytes ?? DJVU_ARTIFACT_FREE_SPACE_RESERVE_BYTES;
    let failure: DjvuDiskQuotaError | null = null;
    let inFlight: Promise<void> | null = null;
    let stopped = false;

    const performCheck = async () => {
        if (failure) throw failure;
        const [
            sizes,
            availableBytes,
        ] = await Promise.all([
            Promise.all(monitoredPaths.map(measurePathBytes)),
            options.readAvailableBytesForTests?.() ?? statfs(options.fileSystemPath).then(
                fileSystem => Number(fileSystem.bavail) * Number(fileSystem.bsize),
            ),
        ]);
        const totalBytes = sizes.reduce((total, size) => total + size, 0);
        if (!Number.isFinite(availableBytes) || availableBytes <= reserveBytes) {
            throw new DjvuDiskQuotaError(
                `temporary storage has ${availableBytes} bytes available; ${reserveBytes} bytes must remain free`,
            );
        }
        const availableCeiling = Number.isFinite(availableBytes)
            ? Math.max(0, availableBytes - reserveBytes)
            : Number.POSITIVE_INFINITY;
        const maxTotalBytes = Math.min(options.maxTotalBytes ?? availableCeiling, availableCeiling);
        if (totalBytes > maxTotalBytes) {
            throw new DjvuDiskQuotaError(
                `artifacts use ${totalBytes} bytes, above the ${maxTotalBytes}-byte ceiling`,
            );
        }
    };
    const checkNow = async () => {
        if (failure) {
            throw failure;
        }
        inFlight ??= performCheck()
            .catch((error: unknown) => {
                failure = error instanceof DjvuDiskQuotaError
                    ? error
                    : new DjvuDiskQuotaError(getErrorMessage(error));
                if (!controller.signal.aborted) controller.abort(failure);
                throw failure;
            })
            .finally(() => {
                inFlight = null;
            });
        return inFlight;
    };

    await checkNow();
    const timer = setInterval(() => {
        if (stopped || signal.aborted) {
            return;
        }
        void checkNow().catch(() => undefined);
    }, options.intervalMs ?? DJVU_QUOTA_MONITOR_INTERVAL_MS);
    timer.unref();

    return {
        signal,
        checkNow,
        get failure() {
            return failure;
        },
        async stop() {
            stopped = true;
            clearInterval(timer);
            await inFlight?.catch(() => undefined);
        },
    };
}

async function sha256File(path: string, signal?: AbortSignal) {
    const hash = createHash('sha256');
    const stream = createReadStream(path, signal ? {signal} : undefined);
    try {
        for await (const chunk of stream) {
            hash.update(chunk as Buffer);
        }
    } finally {
        stream.destroy();
    }
    return hash.digest('hex');
}

function sourceStatsMatch(
    left: Pick<IDjvuSourceIdentity, 'size' | 'mtimeMs' | 'ctimeMs'>,
    right: Pick<IDjvuSourceIdentity, 'size' | 'mtimeMs' | 'ctimeMs'>,
) {
    return left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

export async function assertDjvuSourceIdentity(
    sourcePath: string,
    identity: IDjvuSourceIdentity,
    signal?: AbortSignal,
) {
    signal?.throwIfAborted();
    const source = await stat(sourcePath);
    if (!sourceStatsMatch(identity, source)) {
        throw new Error('DjVu source changed while a checkpoint export was in progress');
    }
}

export async function captureDjvuSourceIdentity(sourcePath: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const sourceBeforeHash = await stat(sourcePath);
    const sourceSha256 = await sha256File(sourcePath, signal);
    const source = await stat(sourcePath);
    const identity = {
        sourceSha256,
        size: source.size,
        mtimeMs: source.mtimeMs,
        ctimeMs: source.ctimeMs,
    } satisfies IDjvuSourceIdentity;
    if (!sourceStatsMatch({
        size: sourceBeforeHash.size,
        mtimeMs: sourceBeforeHash.mtimeMs,
        ctimeMs: sourceBeforeHash.ctimeMs,
    }, identity)) {
        throw new Error('DjVu source changed while its resume fingerprint was being computed');
    }
    return identity;
}

async function acquireFingerprintLock(fingerprint: string) {
    const previous = activeFingerprintTails.get(fingerprint) ?? Promise.resolve();
    const gate = Promise.withResolvers<undefined>();
    const tail = previous.catch(() => undefined).then(() => gate.promise);
    activeFingerprintTails.set(fingerprint, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        gate.resolve(undefined);
        if (activeFingerprintTails.get(fingerprint) === tail) {
            activeFingerprintTails.delete(fingerprint);
        }
    };
}

async function writeManifest(path: string, manifest: IDjvuArtifactManifest) {
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(tempPath, JSON.stringify(manifest), 'utf8');
        await rename(tempPath, path);
    } finally {
        await rm(tempPath, {force: true}).catch(() => undefined);
    }
}

function decodeManifest(value: unknown): IDjvuArtifactManifest | null {
    if (
        !isRecord(value)
        || value.version !== 2
        || typeof value.fingerprint !== 'string'
        || typeof value.sourcePath !== 'string'
        || typeof value.sourceSha256 !== 'string'
        || typeof value.createdAtMs !== 'number'
        || typeof value.updatedAtMs !== 'number'
        || !Array.isArray(value.ranges)
    ) {
        return null;
    }
    const ranges: IDjvuArtifactRange[] = [];
    for (const range of value.ranges) {
        if (
            !isRecord(range)
            || !Number.isSafeInteger(range.startPage)
            || !Number.isSafeInteger(range.endPage)
            || typeof range.outputPath !== 'string'
            || ![
                'pending',
                'running',
                'verified',
                'failed',
            ].includes(String(range.status))
        ) {
            return null;
        }
        ranges.push({
            startPage: Number(range.startPage),
            endPage: Number(range.endPage),
            outputPath: range.outputPath,
            status: range.status === 'running' || range.status === 'verified' || range.status === 'failed'
                ? range.status
                : 'pending',
            ...(typeof range.size === 'number' ? {size: range.size} : {}),
            ...(typeof range.sha256 === 'string' ? {sha256: range.sha256} : {}),
            ...(typeof range.accountedSize === 'number' && Number.isSafeInteger(range.accountedSize) && range.accountedSize > 0
                ? {accountedSize: range.accountedSize}
                : {}),
            ...(typeof range.error === 'string' ? {error: range.error} : {}),
        });
    }
    return {
        version: 2,
        fingerprint: value.fingerprint,
        sourcePath: value.sourcePath,
        sourceSha256: value.sourceSha256,
        createdAtMs: value.createdAtMs,
        updatedAtMs: value.updatedAtMs,
        ranges,
    };
}

function manifestMatchesRequestedJob(
    manifest: IDjvuArtifactManifest,
    fingerprint: string,
    sourcePath: string,
    sourceSha256: string,
    directory: string,
    pageRanges: ReadonlyArray<{
        startPage: number;
        endPage: number;
    }>,
    outputExtension: '.pdf' | '.json',
) {
    return manifest.fingerprint === fingerprint
        && manifest.sourcePath === sourcePath
        && manifest.sourceSha256 === sourceSha256
        && manifest.ranges.length === pageRanges.length
        && manifest.ranges.every((range, index) => {
            const requested = pageRanges[index];
            return requested
                && range.startPage === requested.startPage
                && range.endPage === requested.endPage
                && range.outputPath === join(
                    directory,
                    `pages-${requested.startPage}-${requested.endPage}${outputExtension}`,
                );
        });
}

export async function openDjvuArtifactJob(
    sourcePath: string,
    pageRanges: ReadonlyArray<{
        startPage: number;
        endPage: number
    }>,
    options: {
        subsample?: number;
        artifactKind?: 'pdf-range' | 'compact-page';
        qualityPreset?: string;
        outputExtension?: '.pdf' | '.json';
        maxTotalBytesForTests?: number;
        signal?: AbortSignal;
        sourceIdentity?: IDjvuSourceIdentity;
    },
): Promise<IDjvuArtifactJob> {
    const sourceIdentity = options.sourceIdentity
        ?? await captureDjvuSourceIdentity(sourcePath, options.signal);
    await assertDjvuSourceIdentity(sourcePath, sourceIdentity, options.signal);
    const sourceSha256 = sourceIdentity.sourceSha256;
    const fingerprint = createHash('sha256')
        .update(`${sourcePath}\0${sourceSha256}\0${options.subsample ?? 1}\0${options.artifactKind ?? 'pdf-range'}\0${options.qualityPreset ?? ''}\0`)
        .update(JSON.stringify(pageRanges))
        .digest('hex');
    const jobRoot = await ensureJobRoot();
    const releaseFingerprintLock = await acquireFingerprintLock(fingerprint);
    const directory = join(jobRoot, fingerprint);
    const manifestPath = join(directory, 'manifest.json');
    const outputExtension = options.outputExtension ?? '.pdf';
    try {
        await mkdir(directory, {recursive: true});
        const fileSystem = await statfs(directory).catch(() => null);
        const availableBytes = fileSystem
            ? Number(fileSystem.bavail) * Number(fileSystem.bsize)
            : Number.POSITIVE_INFINITY;
        if (availableBytes <= DJVU_ARTIFACT_FREE_SPACE_RESERVE_BYTES) {
            throw new Error('Not enough free temporary disk space for DjVu artifact conversion');
        }
        const maxTotalBytes = Math.min(
            availableBytes - DJVU_ARTIFACT_FREE_SPACE_RESERVE_BYTES,
            options.maxTotalBytesForTests ?? Number.POSITIVE_INFINITY,
        );
        let manifest = await readFile(manifestPath, 'utf8')
            .then(value => decodeManifest(JSON.parse(value)))
            .catch(() => null);
        if (!manifest || !manifestMatchesRequestedJob(
            manifest,
            fingerprint,
            sourcePath,
            sourceSha256,
            directory,
            pageRanges,
            outputExtension,
        )) {
            const now = Date.now();
            manifest = {
                version: 2,
                fingerprint,
                sourcePath,
                sourceSha256,
                createdAtMs: now,
                updatedAtMs: now,
                ranges: pageRanges.map(range => ({
                    ...range,
                    outputPath: join(directory, `pages-${range.startPage}-${range.endPage}${outputExtension}`),
                    status: 'pending',
                })),
            };
            await writeManifest(manifestPath, manifest);
        } else {
            for (const range of manifest.ranges) {
                if (range.status === 'running') range.status = 'pending';
                if (range.status === 'verified') {
                    const artifact = await stat(range.outputPath).catch(() => null);
                    const digest = artifact && artifact.size > 0 && artifact.size === range.size && range.sha256
                        ? await sha256File(range.outputPath, options.signal).catch(() => null)
                        : null;
                    if (!artifact || artifact.size !== range.size || artifact.size <= 0 || digest !== range.sha256) {
                        range.status = 'pending';
                        delete range.size;
                        delete range.sha256;
                        delete range.accountedSize;
                    }
                }
            }
            manifest.updatedAtMs = Date.now();
            await writeManifest(manifestPath, manifest);
        }
        let writeChain = Promise.resolve();
        let closed = false;
        const close = async () => {
            if (closed) {
                return;
            }
            closed = true;
            try {
                await writeChain;
            } finally {
                releaseFingerprintLock();
            }
        };
        return {
            directory,
            manifestPath,
            manifest,
            sourceIdentity,
            maxTotalBytes,
            close,
            async cleanup() {
                try {
                    await writeChain;
                    await rm(directory, {
                        force: true,
                        recursive: true,
                    });
                } finally {
                    await close();
                }
            },
            async updateRange(index, update, verification) {
                const operation = writeChain.catch(() => undefined).then(async () => {
                    const range = manifest.ranges[index];
                    if (!range) throw new Error(`Unknown DjVu artifact range ${index}`);
                    if (update.status === 'verified') {
                        const additionalArtifacts = verification?.additionalArtifacts ?? [];
                        const allPaths = [
                            range.outputPath,
                            ...additionalArtifacts.map(artifact => artifact.path),
                        ];
                        if (new Set(allPaths.map(path => resolve(path))).size !== allPaths.length) {
                            throw new Error('DjVu artifact verification contains duplicate paths');
                        }
                        if (additionalArtifacts.some(artifact => !isPathInside(artifact.path, directory))) {
                            throw new Error('DjVu artifact verification contains a path outside its job directory');
                        }

                        const verifiedArtifacts: IDjvuArtifactVerification[] = [];
                        for (const path of allPaths) {
                            const beforeHash = await stat(path);
                            if (!beforeHash.isFile() || beforeHash.size <= 0) {
                                throw new Error(`DjVu artifact is empty or not a regular file: ${path}`);
                            }
                            const sha256 = await sha256File(path);
                            const afterHash = await stat(path);
                            if (
                                !afterHash.isFile()
                                || afterHash.size !== beforeHash.size
                                || afterHash.mtimeMs !== beforeHash.mtimeMs
                                || afterHash.ctimeMs !== beforeHash.ctimeMs
                            ) {
                                throw new Error(`DjVu artifact changed while it was being verified: ${path}`);
                            }
                            verifiedArtifacts.push({
                                path,
                                size: afterHash.size,
                                sha256,
                            });
                        }
                        for (const [
                            artifactIndex,
                            expected,
                        ] of additionalArtifacts.entries()) {
                            const actual = verifiedArtifacts[artifactIndex + 1];
                            if (
                                !actual
                                || actual.path !== expected.path
                                || actual.size !== expected.size
                                || actual.sha256 !== expected.sha256
                            ) {
                                throw new Error(`Compact DjVu artifact changed before checkpoint verification: ${expected.path}`);
                            }
                        }

                        const accountedSize = verifiedArtifacts.reduce((total, artifact) => total + artifact.size, 0);
                        const otherVerifiedBytes = manifest.ranges.reduce((total, candidate, candidateIndex) => (
                            candidateIndex !== index && candidate.status === 'verified'
                                ? total + (candidate.accountedSize ?? candidate.size ?? 0)
                                : total
                        ), 0);
                        if (otherVerifiedBytes + accountedSize > maxTotalBytes) {
                            await Promise.all(allPaths.map(path => rm(path, {force: true}).catch(() => undefined)));
                            Object.assign(range, {
                                status: 'failed',
                                size: undefined,
                                sha256: undefined,
                                accountedSize: undefined,
                                error: new DjvuDiskQuotaError(
                                    `artifacts exceed the ${maxTotalBytes}-byte ceiling`,
                                ).message,
                            });
                            manifest.updatedAtMs = Date.now();
                            await writeManifest(manifestPath, manifest);
                            throw new DjvuDiskQuotaError(`artifacts exceed the ${maxTotalBytes}-byte ceiling`);
                        }
                        const primaryArtifact = verifiedArtifacts[0]!;
                        Object.assign(range, update, {
                            size: primaryArtifact.size,
                            sha256: primaryArtifact.sha256,
                            accountedSize,
                        });
                    } else {
                        Object.assign(range, update);
                    }
                    manifest.updatedAtMs = Date.now();
                    await writeManifest(manifestPath, manifest);
                });
                writeChain = operation.then(() => undefined, () => undefined);
                await operation;
            },
        };
    } catch (error) {
        releaseFingerprintLock();
        throw error;
    }
}

export async function pruneStaleDjvuArtifactJobs(now = Date.now()) {
    const { readdir } = await import('node:fs/promises');
    const jobRoot = await ensureJobRoot();
    const entries = await readdir(jobRoot, {withFileTypes: true}).catch(() => []);
    const jobDirectories = entries.filter(entry => entry.isDirectory());
    const retained: Array<{
        directory: string;
        mtimeMs: number
    }> = [];
    await Promise.all(jobDirectories.map(async (entry) => {
        const directory = join(jobRoot, entry.name);
        const info = await stat(join(directory, 'manifest.json')).catch(() => null);
        if (!info || now - info.mtimeMs > STALE_JOB_MS) {
            await rm(directory, {
                force: true,
                recursive: true,
            });
            return;
        }
        retained.push({
            directory,
            mtimeMs: info.mtimeMs,
        });
    }));
    retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(retained.slice(32).map(entry => rm(entry.directory, {
        force: true,
        recursive: true,
    })));
}
