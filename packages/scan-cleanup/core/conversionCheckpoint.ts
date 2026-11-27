import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {copyFile, link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile} from 'node:fs/promises';
import {basename, join, resolve, sep} from 'node:path';
import * as v from 'valibot';
import {SCAN_CLEANUP_OUTPUT_HALVES, SCAN_CLEANUP_OUTPUT_MODES, SCAN_CLEANUP_PAGE_ROTATIONS} from '@contracts/scan-cleanup/domain';
import type {TNativeScanCleanupDocumentInkPriorV3, TScanCleanupSummary} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {NATIVE_SCAN_CLEANUP_DOCUMENT_INK_PRIOR_SCHEMA} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/ipc';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {isRecord} from '@contracts/runtimeGuards';
import type {IScanCleanupTextLayerInstruction} from '@evb/scan-cleanup/core/compactManifest';
import {
    canonicalScanCleanupJson,
    SCAN_CLEANUP_PROVENANCE_STAMP_SCHEMA,
    type TScanCleanupProvenanceStamp,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {sha256Utf8Hex} from '@evb/scan-cleanup/core/sha256Utf8Hex';
import type {TScanCleanupPageScope} from '@evb/scan-cleanup/core/pageScope';
import type {
    IRunScanCleanupPipelineRequest,
    IScanCleanupOutputMapping,
    IScanCleanupOutputPageForSummary,
    IScanCleanupRepresentationReport,
    TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';

const CHECKPOINT_SCHEMA_VERSION = 2 as const;
const CHECKPOINT_ENTRY_PREFIX = 'entry-';
const CHECKPOINT_MANIFEST_FILENAME = 'checkpoint.json';
const CHECKPOINT_ARTIFACTS_DIRNAME = 'artifacts';
const CHECKPOINT_TEMP_SUFFIX = '.tmp';
const CHECKPOINT_DIR_LOCK_FILENAME = '.checkpoint.lock';
const CHECKPOINT_RECLAIM_LOCK_PREFIX = '.checkpoint.reclaim-';
const CHECKPOINT_LEASE_PREFIX = '.lease-';
const CHECKPOINT_LEASE_SUFFIX = '.lock';
const CHECKPOINT_LOCK_CORRUPT_GRACE_MS = 5_000;
const CHECKPOINT_LOCK_MAX_WAIT_MS = 30_000;
const CHECKPOINT_LOCK_RETRY_MS = 10;
const MAX_RECLAIM_LOCK_DEPTH = 4;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SAFE_RECLAIM_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const EXCLUSIVE_CREATE_FLAGS = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW_FLAG;

// In-process coordination maps keyed by canonical realpath.
const inProcessDirLocks = new Map<string, Promise<void>>();
// Keyed by entryRealPath -> (ownerId -> active handle count).
const inProcessActiveEntryLeases = new Map<string, Map<string, number>>();

export interface IScanCleanupCheckpointArtifactRecord {
    fileName: string;
    /** Generation-tagged on-disk filename inside the page directory (defaults to `fileName` for legacy records). */
    storedFileName?: string;
    sizeBytes: number;
    sha256: string;
}

export interface IScanCleanupCheckpointedPageRecord {
    pageNumber: number;
    planSignature: string;
    artifacts: IScanCleanupCheckpointArtifactRecord[];
}

export interface IScanCleanupCheckpointedInkPriorRecord {
    planSignature: string;
    prior: TNativeScanCleanupDocumentInkPriorV3;
}

export interface IScanCleanupCheckpointedBatchState {
    batchIndex: number;
    firstPageNumber: number;
    batchSignature: string;
    hasBatchPdf: boolean;
    batchPdfSizeBytes: number | null;
    summary: TScanCleanupSummary;
    representationReport: IScanCleanupRepresentationReport | null;
    provenanceStamp: TScanCleanupProvenanceStamp | null;
    sourceTextPages: IScanCleanupTextLayerInstruction[];
    skippedNonAffine: number[];
}

interface IScanCleanupCheckpointedBatchRecord {
    batchIndex: number;
    batchSignature: string;
    stateFileName: string;
    stateSizeBytes: number;
    stateSha256: string;
    pdfFileName: string | null;
    pdfSizeBytes: number | null;
    pdfSha256: string | null;
}

interface IScanCleanupCheckpointManifest {
    schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
    witnessId: string;
    sourceSha256: string;
    optionsSignature: string;
    sourcePath: string;
    documentPageCount: number;
    mode: 'batch' | 'streaming';
    updatedAtMs: number;
    completedPages: Record<string, IScanCleanupCheckpointedPageRecord>;
    completedBatches: Record<string, IScanCleanupCheckpointedBatchRecord>;
    documentInkPriors: Record<string, IScanCleanupCheckpointedInkPriorRecord>;
}

export interface IScanCleanupCheckpointWitness {
    sourceSha256: string;
    optionsSignature: string;
    witnessId: string;
}

export interface IScanCleanupPageArtifactInput {
    scratchPath: string;
    fileName: string;
}

export interface IScanCleanupCheckpointFileSystemHooks {
    rename?: typeof rename;
    /** Deterministic test hook invoked after observing `.checkpoint.lock` via `lstat` and before reading it. */
    afterLockLstat?: (info: {lockPath: string; mtimeMs: number}) => Promise<void> | void;
    /** Deterministic test hook invoked immediately after creating `.checkpoint.lock` (0 bytes) and before writing metadata. */
    afterLockOpenBeforeWrite?: (info: {lockPath: string}) => Promise<void> | void;
    /** Deterministic test hook invoked after observing a stale lock and before creating its reclaim lock. */
    beforeStaleLockReclaim?: (info: {targetFileName: string; staleToken: string | null}) => Promise<void> | void;
    /** Deterministic test hook invoked while holding the reclaim lock right before unlinking the stale lock. */
    beforeStaleLockUnlink?: (info: {targetFileName: string; staleToken: string | null; reclaimFileName: string}) => Promise<void> | void;
}

export interface IScanCleanupConversionCheckpoint {
    readonly witness: IScanCleanupCheckpointWitness;
    readonly entryDir: string;
    readonly resumed: boolean;
    getDocumentInkPrior: (expectedPlanSignature: string, scopeKey?: string) => Promise<TNativeScanCleanupDocumentInkPriorV3 | null>;
    restoreCompletedPages: (
        scratchDir: string,
        expectedPageNumbers: readonly number[],
        expectedPlanSignature: string,
        scopeKey?: string,
    ) => Promise<Set<number>>;
    commitCompletedPages: (
        pages: ReadonlyArray<{
            pageNumber: number;
            artifacts: readonly IScanCleanupPageArtifactInput[];
        }>,
        planSignature: string,
        scopeKey?: string,
        documentInkPrior?: TNativeScanCleanupDocumentInkPriorV3 | null,
    ) => Promise<void>;
    restoreCompletedBatch: (
        batchIndex: number,
        expectedBatchSignature: string,
        expectedPageNumbers: readonly number[],
        targetBatchPdfPath: string,
    ) => Promise<IScanCleanupCheckpointedBatchState | null>;
    commitCompletedBatch: (input: {
        batchIndex: number;
        firstPageNumber: number;
        batchSignature: string;
        batchPdfPath: string | null;
        summary: TScanCleanupSummary;
        representationReport: IScanCleanupRepresentationReport | null;
        provenanceStamp: TScanCleanupProvenanceStamp | null;
        sourceTextPages: readonly IScanCleanupTextLayerInstruction[];
        skippedNonAffine: readonly number[];
    }) => Promise<void>;
    cleanupTempFiles: () => Promise<void>;
    close: () => Promise<void>;
    complete: () => Promise<void>;
}

function stripUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripUndefined);
    }
    if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined) {
                result[key] = stripUndefined(entry);
            }
        }
        return result;
    }
    return value;
}

function serializePageScope(pageScope: TScanCleanupPageScope) {
    if ('startPageNumber' in pageScope) {
        return {
            kind: 'range',
            startPageNumber: pageScope.startPageNumber,
            endPageNumber: pageScope.endPageNumber,
        };
    }
    return {
        kind: 'list',
        pages: [...pageScope],
    };
}

function isSha256Hex(value: unknown): value is string {
    return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

function isSafeSegment(segment: string) {
    return (
        segment.length > 0 &&
        !segment.includes('/') &&
        !segment.includes('\\') &&
        !segment.includes('\0') &&
        segment !== '.' &&
        segment !== '..' &&
        basename(segment) === segment
    );
}

function isWithinRealRoot(rootRealPath: string, candidateRealPath: string) {
    const prefix = rootRealPath.endsWith(sep) ? rootRealPath : `${rootRealPath}${sep}`;
    return candidateRealPath === rootRealPath || candidateRealPath.startsWith(prefix);
}

function isAllowedPageArtifactFileName(pageNumber: number, fileName: string) {
    if (!isSafeSegment(fileName)) {
        return false;
    }
    const prefix = `clean-${String(pageNumber)}-`;
    if (!fileName.startsWith(prefix)) {
        return false;
    }
    const suffix = fileName.slice(prefix.length);
    if (suffix === 'page.json') {
        return true;
    }
    return /^[01]\.(?:json|png|pbm)$/.test(suffix) || /^[01]-(?:background\.ppm|mask\.pbm|alpha\.pgm)$/.test(suffix);
}

function isProcessAlive(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        return code === 'EPERM';
    }
}

function delayMs(ms: number) {
    return new Promise<void>((resolveTimer) => {
        setTimeout(resolveTimer, ms);
    });
}

async function resolveCanonicalCheckpointRootIfExists(checkpointDir: string): Promise<string | null> {
    let existing;
    try {
        existing = await lstat(checkpointDir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (existing.isSymbolicLink()) {
        throw new Error(`Scan cleanup checkpoint directory must not be a symbolic link: ${checkpointDir}`);
    }
    if (!existing.isDirectory()) {
        throw new Error(`Scan cleanup checkpoint path is not a directory: ${checkpointDir}`);
    }
    return realpath(checkpointDir);
}

async function resolveCanonicalCheckpointRoot(checkpointDir: string): Promise<string> {
    const existing = await resolveCanonicalCheckpointRootIfExists(checkpointDir);
    if (existing !== null) {
        return existing;
    }
    await mkdir(checkpointDir, {recursive: true});
    const created = await lstat(checkpointDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Scan cleanup checkpoint directory is invalid: ${checkpointDir}`);
    }
    return realpath(checkpointDir);
}

async function assertContainedRealDirectory(
    rootRealPath: string,
    relativeSegments: readonly string[],
    createMissing: boolean,
): Promise<string> {
    let current = rootRealPath;
    for (const segment of relativeSegments) {
        if (!isSafeSegment(segment)) {
            throw new Error(`Unsafe scan cleanup checkpoint path segment: ${segment}`);
        }
        const next = join(current, segment);
        let stats;
        try {
            stats = await lstat(next);
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT' || !createMissing) {
                throw error;
            }
            await mkdir(next);
            stats = await lstat(next);
        }
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to traverse symbolic link inside scan cleanup checkpoint: ${next}`);
        }
        if (!stats.isDirectory()) {
            throw new Error(`Expected directory inside scan cleanup checkpoint: ${next}`);
        }
        const resolvedNext = await realpath(next);
        if (!isWithinRealRoot(rootRealPath, resolvedNext)) {
            throw new Error(`Scan cleanup checkpoint directory escapes root: ${next}`);
        }
        current = resolvedNext;
    }
    return current;
}

async function tryResolveContainedRealDirectory(rootRealPath: string, relativeSegments: readonly string[]): Promise<string | null> {
    try {
        return await assertContainedRealDirectory(rootRealPath, relativeSegments, false);
    } catch {
        return null;
    }
}

async function readRegularFileNoFollow(
    rootRealPath: string,
    parentRealDir: string,
    fileName: string,
): Promise<{
    bytes: Buffer;
    sizeBytes: number;
    sha256: string;
    dev: number;
    ino: number;
    mtimeMs: number;
} | null> {
    if (!isSafeSegment(fileName) || !isWithinRealRoot(rootRealPath, parentRealDir)) {
        return null;
    }
    const filePath = join(parentRealDir, fileName);
    let linkStats;
    try {
        linkStats = await lstat(filePath);
    } catch {
        return null;
    }
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
        return null;
    }
    let handle;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
    } catch {
        return null;
    }
    try {
        const fdStats = await handle.stat();
        if (!fdStats.isFile() || fdStats.dev !== linkStats.dev || fdStats.ino !== linkStats.ino) {
            return null;
        }
        const bytes = await handle.readFile();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return {
            bytes,
            sizeBytes: bytes.byteLength,
            sha256,
            dev: fdStats.dev,
            ino: fdStats.ino,
            mtimeMs: fdStats.mtimeMs,
        };
    } catch {
        return null;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function hashRegularFileNoFollow(
    rootRealPath: string,
    parentRealDir: string,
    fileName: string,
): Promise<{
    sizeBytes: number;
    sha256: string;
} | null> {
    if (!isSafeSegment(fileName) || !isWithinRealRoot(rootRealPath, parentRealDir)) {
        return null;
    }
    const filePath = join(parentRealDir, fileName);
    let linkStats;
    try {
        linkStats = await lstat(filePath);
    } catch {
        return null;
    }
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
        return null;
    }
    let handle;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
    } catch {
        return null;
    }
    try {
        const fdStats = await handle.stat();
        if (!fdStats.isFile() || fdStats.dev !== linkStats.dev || fdStats.ino !== linkStats.ino) {
            return null;
        }
        const hash = createHash('sha256');
        let totalBytes = 0;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
            const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }
            totalBytes += bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
        }
        return {
            sizeBytes: totalBytes,
            sha256: hash.digest('hex'),
        };
    } catch {
        return null;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function writeFullBuffer(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, length: number) {
    let offset = 0;
    while (offset < length) {
        const {bytesWritten} = await handle.write(buffer, offset, length - offset);
        if (bytesWritten <= 0) {
            throw new Error('Short write while streaming scan cleanup checkpoint artifact');
        }
        offset += bytesWritten;
    }
}

/**
 * Stream a regular non-symlink checkpoint file into a temp file beside
 * `targetPath`, optionally verifying exact byte size and SHA-256 digest in one
 * pass, then atomically rename into place. Never buffers the entire file in
 * memory, so multi-GiB batch PDFs never exceed Node's Buffer size ceiling.
 */
async function streamCopyRegularFileNoFollowToTarget(
    rootRealPath: string,
    parentRealDir: string,
    fileName: string,
    targetPath: string,
    renameFn: typeof rename,
    verification?: {
        expectedSizeBytes: number;
        expectedSha256: string;
    },
): Promise<'ok' | 'mismatch'> {
    if (!isSafeSegment(fileName) || !isWithinRealRoot(rootRealPath, parentRealDir)) {
        return 'mismatch';
    }
    const sourcePath = join(parentRealDir, fileName);
    let linkStats;
    try {
        linkStats = await lstat(sourcePath);
    } catch {
        return 'mismatch';
    }
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
        return 'mismatch';
    }
    let srcHandle;
    try {
        srcHandle = await open(sourcePath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
    } catch {
        return 'mismatch';
    }
    const tempPath = `${targetPath}.${randomUUID()}${CHECKPOINT_TEMP_SUFFIX}`;
    let dstHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        const fdStats = await srcHandle.stat();
        if (!fdStats.isFile() || fdStats.dev !== linkStats.dev || fdStats.ino !== linkStats.ino) {
            return 'mismatch';
        }
        if (verification !== undefined && fdStats.size !== verification.expectedSizeBytes) {
            return 'mismatch';
        }
        dstHandle = await open(tempPath, 'wx');
        const hash = verification === undefined ? null : createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let totalBytes = 0;
        while (true) {
            const {bytesRead} = await srcHandle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }
            totalBytes += bytesRead;
            hash?.update(buffer.subarray(0, bytesRead));
            await writeFullBuffer(dstHandle, buffer, bytesRead);
        }
        await dstHandle.close();
        dstHandle = null;
        if (verification !== undefined) {
            const digest = hash!.digest('hex');
            if (totalBytes !== verification.expectedSizeBytes || digest !== verification.expectedSha256) {
                await rm(tempPath, {force: true}).catch(() => undefined);
                return 'mismatch';
            }
        }
        await renameFn(tempPath, targetPath);
        return 'ok';
    } catch (error) {
        if (dstHandle !== null) {
            await dstHandle.close().catch(() => undefined);
        }
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    } finally {
        await srcHandle.close().catch(() => undefined);
    }
}

async function safeRemoveContainedDirectoryTree(rootRealPath: string, targetPath: string): Promise<void> {
    let stats;
    try {
        stats = await lstat(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    if (stats.isSymbolicLink()) {
        // Never traverse through a symlink during cleanup; unlink only the link itself.
        await unlink(targetPath).catch(() => undefined);
        return;
    }
    const resolvedTarget = await realpath(targetPath);
    if (!isWithinRealRoot(rootRealPath, resolvedTarget) || resolvedTarget === rootRealPath) {
        throw new Error(`Refusing to remove path outside scan cleanup checkpoint root: ${targetPath}`);
    }
    if (!stats.isDirectory()) {
        await unlink(resolvedTarget).catch(() => undefined);
        return;
    }
    const entries = await readdir(resolvedTarget, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
        if (!isSafeSegment(entry.name)) {
            continue;
        }
        const childPath = join(resolvedTarget, entry.name);
        if (entry.isSymbolicLink() || entry.isFile()) {
            await unlink(childPath).catch(() => undefined);
        } else if (entry.isDirectory()) {
            await safeRemoveContainedDirectoryTree(rootRealPath, childPath);
        } else {
            await unlink(childPath).catch(() => undefined);
        }
    }
    await rmdir(resolvedTarget).catch(() => undefined);
}

interface IParsedLockMetadata {
    pid: number;
    ownerId: string | null;
    token: string | null;
}

function parseLockMetadata(bytes: Buffer): IParsedLockMetadata | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
        return null;
    }
    if (!isRecord(parsed) || typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
        return null;
    }
    return {
        pid: parsed.pid,
        ownerId: typeof parsed.ownerId === 'string' && parsed.ownerId.length > 0 ? parsed.ownerId : null,
        token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null,
    };
}

function toSafeReclaimKey(staleToken: string | null, dev: number, ino: number) {
    if (staleToken !== null) {
        return SAFE_RECLAIM_TOKEN_RE.test(staleToken) ? staleToken : sha256Utf8Hex(staleToken).slice(0, 32);
    }
    return `corrupt-${String(dev)}-${String(ino)}`;
}

function isLockMetadataReclaimable(parsed: IParsedLockMetadata | null, mtimeMs: number, confirmedDeadOwnerId?: string) {
    if (confirmedDeadOwnerId !== undefined) {
        return parsed !== null && parsed.pid === process.pid && parsed.ownerId === confirmedDeadOwnerId;
    }
    if (parsed !== null) {
        // Never steal a lock whose owner PID is still alive, regardless of age.
        return !isProcessAlive(parsed.pid);
    }
    return Date.now() - mtimeMs > CHECKPOINT_LOCK_CORRUPT_GRACE_MS;
}

async function releaseOwnedLockFile(
    rootRealPath: string,
    fileName: string,
    ownDev: number,
    ownIno: number,
    ownToken: string,
    ownOwnerId: string,
) {
    const currentLock = await readRegularFileNoFollow(rootRealPath, rootRealPath, fileName);
    if (currentLock === null || currentLock.dev !== ownDev || currentLock.ino !== ownIno) {
        return;
    }
    const parsed = parseLockMetadata(currentLock.bytes);
    if (parsed !== null && parsed.pid === process.pid && parsed.token === ownToken && parsed.ownerId === ownOwnerId) {
        await unlink(join(rootRealPath, fileName)).catch(() => undefined);
    }
}

/**
 * Atomically publish a fully populated lock file without overwriting an
 * existing file: writes the complete JSON payload to a unique `.tmp` file,
 * closes it, and hard-links it into `fileName` via `link()` (which fails
 * atomically with `EEXIST` if already present and never exposes a 0-byte lock).
 *
 * Falls back to `open(..., O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW)` with
 * explicit unlink-on-write-failure rollback ONLY when hard links are
 * unsupported (`EPERM` / `ENOTSUP` / `EXDEV`) or when the deterministic
 * `afterLockOpenBeforeWrite` fallback test hook is supplied.
 */
async function createLockFileAtomicallyNoReplace(
    rootRealPath: string,
    fileName: string,
    payloadJson: string,
    hooks?: IScanCleanupCheckpointFileSystemHooks,
): Promise<{
    dev: number;
    ino: number;
}> {
    const targetPath = join(rootRealPath, fileName);
    const createViaExclusiveOpen = async () => {
        let createdLockFile = false;
        const handle = await open(targetPath, EXCLUSIVE_CREATE_FLAGS);
        createdLockFile = true;
        try {
            const ownStats = await handle.stat();
            await hooks?.afterLockOpenBeforeWrite?.({lockPath: targetPath});
            await handle.writeFile(payloadJson, 'utf8');
            await handle.close();
            return {
                dev: ownStats.dev,
                ino: ownStats.ino,
            };
        } catch (error) {
            await handle.close().catch(() => undefined);
            if (createdLockFile) {
                await unlink(targetPath).catch(() => undefined);
            }
            throw error;
        }
    };

    if (hooks?.afterLockOpenBeforeWrite !== undefined) {
        return createViaExclusiveOpen();
    }

    const tempPath = join(rootRealPath, `${fileName}.${randomUUID()}${CHECKPOINT_TEMP_SUFFIX}`);
    try {
        const tmpHandle = await open(tempPath, EXCLUSIVE_CREATE_FLAGS);
        let tmpStats;
        try {
            await tmpHandle.writeFile(payloadJson, 'utf8');
            tmpStats = await tmpHandle.stat();
        } finally {
            await tmpHandle.close();
        }
        try {
            await link(tempPath, targetPath);
            return {
                dev: tmpStats.dev,
                ino: tmpStats.ino,
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
                return await createViaExclusiveOpen();
            }
            throw error;
        }
    } finally {
        await unlink(tempPath).catch(() => undefined);
    }
}

/**
 * Serialize reclaiming a stale `.checkpoint.lock` (or dead `.checkpoint.reclaim-*`)
 * through an exclusive token-keyed reclaim lock `.checkpoint.reclaim-<staleToken>`.
 *
 * Only the contender that wins atomic exclusive creation on the reclaim lock
 * may re-verify `(dev, ino, token)` via `O_NOFOLLOW` and unlink the stale
 * target, preventing two contenders from racing and unlinking a live successor's
 * lock even if the reclaim lock was already cleaned up by an earlier winner.
 */
async function tryReclaimLockFileSerialized(input: {
    rootRealPath: string;
    targetFileName: string;
    targetDev: number;
    targetIno: number;
    targetSha256: string;
    targetMeta: IParsedLockMetadata | null;
    callerOwnerId: string;
    confirmedDeadOwnerId?: string;
    hooks?: IScanCleanupCheckpointFileSystemHooks;
    depth?: number;
}): Promise<boolean> {
    const depth = input.depth ?? 0;
    if (depth >= MAX_RECLAIM_LOCK_DEPTH) {
        return false;
    }
    const staleToken = input.targetMeta?.token ?? null;
    const reclaimFileName = `${CHECKPOINT_RECLAIM_LOCK_PREFIX}${toSafeReclaimKey(staleToken, input.targetDev, input.targetIno)}`;
    if (reclaimFileName === input.targetFileName || !isSafeSegment(reclaimFileName)) {
        return false;
    }
    if (depth === 0) {
        await input.hooks?.beforeStaleLockReclaim?.({
            targetFileName: input.targetFileName,
            staleToken,
        });
    }

    const reclaimPath = join(input.rootRealPath, reclaimFileName);
    const reclaimToken = randomBytes(16).toString('hex');
    let reclaimDev = -1;
    let reclaimIno = -1;
    let acquiredReclaimLock = false;

    try {
        const created = await createLockFileAtomicallyNoReplace(
            input.rootRealPath,
            reclaimFileName,
            JSON.stringify({
                pid: process.pid,
                ownerId: input.callerOwnerId,
                token: reclaimToken,
                targetFileName: input.targetFileName,
                targetToken: staleToken,
                acquiredAtMs: Date.now(),
            }),
        );
        reclaimDev = created.dev;
        reclaimIno = created.ino;
        acquiredReclaimLock = true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'EEXIST') {
            throw error;
        }
        const reclaimLinkStats = await lstat(reclaimPath).catch(() => null);
        if (reclaimLinkStats === null) {
            return false;
        }
        if (reclaimLinkStats.isSymbolicLink()) {
            throw new Error(`Scan cleanup checkpoint reclaim lock is a symbolic link: ${reclaimPath}`);
        }
        if (!reclaimLinkStats.isFile()) {
            throw new Error(`Scan cleanup checkpoint reclaim lock is not a regular file: ${reclaimPath}`);
        }
        const reclaimRead = await readRegularFileNoFollow(input.rootRealPath, input.rootRealPath, reclaimFileName);
        if (reclaimRead !== null) {
            const reclaimMeta = parseLockMetadata(reclaimRead.bytes);
            const reclaimDeadByPidOrCorrupt = isLockMetadataReclaimable(reclaimMeta, reclaimRead.mtimeMs);
            const reclaimDeadByOwner =
                input.confirmedDeadOwnerId !== undefined &&
                isLockMetadataReclaimable(reclaimMeta, reclaimRead.mtimeMs, input.confirmedDeadOwnerId);
            if (reclaimDeadByPidOrCorrupt || reclaimDeadByOwner) {
                await tryReclaimLockFileSerialized({
                    rootRealPath: input.rootRealPath,
                    targetFileName: reclaimFileName,
                    targetDev: reclaimRead.dev,
                    targetIno: reclaimRead.ino,
                    targetSha256: reclaimRead.sha256,
                    targetMeta: reclaimMeta,
                    callerOwnerId: input.callerOwnerId,
                    ...(reclaimDeadByOwner && input.confirmedDeadOwnerId !== undefined
                        ? {confirmedDeadOwnerId: input.confirmedDeadOwnerId}
                        : {}),
                    depth: depth + 1,
                });
            }
        }
        return false;
    }

    try {
        if (depth === 0) {
            await input.hooks?.beforeStaleLockUnlink?.({
                targetFileName: input.targetFileName,
                staleToken,
                reclaimFileName,
            });
        }
        const currentTarget = await readRegularFileNoFollow(input.rootRealPath, input.rootRealPath, input.targetFileName);
        if (currentTarget === null) {
            return false;
        }
        if (currentTarget.dev !== input.targetDev || currentTarget.ino !== input.targetIno) {
            return false;
        }
        const currentMeta = parseLockMetadata(currentTarget.bytes);
        if (staleToken !== null) {
            if (
                currentMeta === null ||
                currentMeta.token !== staleToken ||
                !isLockMetadataReclaimable(currentMeta, currentTarget.mtimeMs, input.confirmedDeadOwnerId)
            ) {
                return false;
            }
        } else if (
            currentMeta !== null ||
            currentTarget.sha256 !== input.targetSha256 ||
            !isLockMetadataReclaimable(null, currentTarget.mtimeMs)
        ) {
            return false;
        }
        try {
            await unlink(join(input.rootRealPath, input.targetFileName));
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
        }
    } finally {
        if (acquiredReclaimLock) {
            await releaseOwnedLockFile(input.rootRealPath, reclaimFileName, reclaimDev, reclaimIno, reclaimToken, input.callerOwnerId);
        }
    }
}

async function sweepDeadReclaimLocks(rootRealPath: string, callerOwnerId: string, confirmedDeadOwnerId?: string): Promise<number> {
    const entries = await readdir(rootRealPath, {withFileTypes: true}).catch(() => []);
    let reclaimed = 0;
    for (const entry of entries) {
        if (
            !isSafeSegment(entry.name) ||
            entry.isSymbolicLink() ||
            !entry.isFile() ||
            !entry.name.startsWith(CHECKPOINT_RECLAIM_LOCK_PREFIX) ||
            entry.name.endsWith(CHECKPOINT_TEMP_SUFFIX)
        ) {
            continue;
        }
        const lockRead = await readRegularFileNoFollow(rootRealPath, rootRealPath, entry.name);
        if (lockRead === null) {
            continue;
        }
        const parsed = parseLockMetadata(lockRead.bytes);
        const reclaimable = isLockMetadataReclaimable(parsed, lockRead.mtimeMs, confirmedDeadOwnerId);
        if (!reclaimable) {
            continue;
        }
        const removed = await tryReclaimLockFileSerialized({
            rootRealPath,
            targetFileName: entry.name,
            targetDev: lockRead.dev,
            targetIno: lockRead.ino,
            targetSha256: lockRead.sha256,
            targetMeta: parsed,
            callerOwnerId,
            ...(confirmedDeadOwnerId === undefined ? {} : {confirmedDeadOwnerId}),
            depth: 1,
        });
        if (removed) {
            reclaimed += 1;
        }
    }
    return reclaimed;
}

interface IWithCheckpointDirLockOptions {
    lockTimeoutMs?: number | undefined;
    ownerId?: string | undefined;
    hooks?: IScanCleanupCheckpointFileSystemHooks | undefined;
}

async function withCheckpointDirLock<T>(rootRealPath: string, task: () => Promise<T>, options?: IWithCheckpointDirLockOptions): Promise<T> {
    const lockTimeoutMs = options?.lockTimeoutMs ?? CHECKPOINT_LOCK_MAX_WAIT_MS;
    const ownerId = options?.ownerId ?? randomUUID();
    const hooks = options?.hooks;
    const previous = inProcessDirLocks.get(rootRealPath) ?? Promise.resolve();
    let releaseInProcess: () => void = () => undefined;
    const current = new Promise<void>((resolveLock) => {
        releaseInProcess = resolveLock;
    });
    const tail = previous.then(() => current);
    inProcessDirLocks.set(rootRealPath, tail);

    await previous;
    const lockPath = join(rootRealPath, CHECKPOINT_DIR_LOCK_FILENAME);
    const lockToken = randomBytes(16).toString('hex');
    const deadline = Date.now() + Math.max(1, lockTimeoutMs);
    let acquiredCrossProcess = false;
    let ownDev = -1;
    let ownIno = -1;

    try {
        while (!acquiredCrossProcess) {
            try {
                const created = await createLockFileAtomicallyNoReplace(
                    rootRealPath,
                    CHECKPOINT_DIR_LOCK_FILENAME,
                    JSON.stringify({
                        pid: process.pid,
                        ownerId,
                        token: lockToken,
                        acquiredAtMs: Date.now(),
                    }),
                    hooks,
                );
                ownDev = created.dev;
                ownIno = created.ino;
                acquiredCrossProcess = true;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException | null)?.code;
                if (code !== 'EEXIST') {
                    throw error;
                }
                const lockLinkStats = await lstat(lockPath).catch(() => null);
                if (lockLinkStats === null) {
                    continue;
                }
                if (lockLinkStats.isSymbolicLink()) {
                    throw new Error(`Scan cleanup checkpoint lock is a symbolic link: ${lockPath}`);
                }
                if (!lockLinkStats.isFile()) {
                    throw new Error(`Scan cleanup checkpoint lock is not a regular file: ${lockPath}`);
                }
                await hooks?.afterLockLstat?.({
                    lockPath,
                    mtimeMs: lockLinkStats.mtimeMs,
                });
                let recoveredDeadOwner = false;
                const lockRead = await readRegularFileNoFollow(rootRealPath, rootRealPath, CHECKPOINT_DIR_LOCK_FILENAME);
                if (lockRead !== null) {
                    const parsed = parseLockMetadata(lockRead.bytes);
                    if (isLockMetadataReclaimable(parsed, lockRead.mtimeMs)) {
                        recoveredDeadOwner = await tryReclaimLockFileSerialized({
                            rootRealPath,
                            targetFileName: CHECKPOINT_DIR_LOCK_FILENAME,
                            targetDev: lockRead.dev,
                            targetIno: lockRead.ino,
                            targetSha256: lockRead.sha256,
                            targetMeta: parsed,
                            callerOwnerId: ownerId,
                            ...(hooks === undefined ? {} : {hooks}),
                        });
                    }
                }
                if (recoveredDeadOwner) {
                    continue;
                }
                if (Date.now() >= deadline) {
                    throw new Error(`Timed out waiting for scan cleanup checkpoint lock: ${lockPath}`);
                }
                await delayMs(CHECKPOINT_LOCK_RETRY_MS);
            }
        }
        await sweepDeadReclaimLocks(rootRealPath, ownerId).catch(() => undefined);
        return await task();
    } finally {
        if (acquiredCrossProcess) {
            await releaseOwnedLockFile(rootRealPath, CHECKPOINT_DIR_LOCK_FILENAME, ownDev, ownIno, lockToken, ownerId);
        }
        releaseInProcess();
        if (inProcessDirLocks.get(rootRealPath) === tail) {
            inProcessDirLocks.delete(rootRealPath);
        }
    }
}

function incrementInProcessEntryLease(entryRealPath: string, ownerId: string) {
    let byOwner = inProcessActiveEntryLeases.get(entryRealPath);
    if (byOwner === undefined) {
        byOwner = new Map<string, number>();
        inProcessActiveEntryLeases.set(entryRealPath, byOwner);
    }
    byOwner.set(ownerId, (byOwner.get(ownerId) ?? 0) + 1);
}

function decrementInProcessEntryLease(entryRealPath: string, ownerId: string) {
    const byOwner = inProcessActiveEntryLeases.get(entryRealPath);
    if (byOwner === undefined) {
        return;
    }
    const next = (byOwner.get(ownerId) ?? 1) - 1;
    if (next <= 0) {
        byOwner.delete(ownerId);
    } else {
        byOwner.set(ownerId, next);
    }
    if (byOwner.size === 0) {
        inProcessActiveEntryLeases.delete(entryRealPath);
    }
}

function clearInProcessOwnerLeasesUnderRoot(rootRealPath: string, ownerId: string) {
    for (const [entryRealPath, byOwner] of inProcessActiveEntryLeases) {
        if (!isWithinRealRoot(rootRealPath, entryRealPath)) {
            continue;
        }
        byOwner.delete(ownerId);
        if (byOwner.size === 0) {
            inProcessActiveEntryLeases.delete(entryRealPath);
        }
    }
}

function hasInProcessActiveEntryLease(entryRealPath: string) {
    const byOwner = inProcessActiveEntryLeases.get(entryRealPath);
    if (byOwner === undefined) {
        return false;
    }
    for (const count of byOwner.values()) {
        if (count > 0) {
            return true;
        }
    }
    return false;
}

function checkpointOwnerTag(ownerId: string) {
    return sha256Utf8Hex(ownerId).slice(0, 32);
}

function parseLeaseFileName(fileName: string): {
    pid: number;
    ownerTag: string | null;
} | null {
    const taggedMatch = /^\.lease-(\d+)-([0-9a-f]{32})-[^/\\]+\.lock$/.exec(fileName);
    if (taggedMatch !== null) {
        return {
            pid: Number(taggedMatch[1]),
            ownerTag: taggedMatch[2]!,
        };
    }
    const legacyMatch = /^\.lease-(\d+)-[^/\\]+\.lock$/.exec(fileName);
    if (legacyMatch !== null) {
        return {
            pid: Number(legacyMatch[1]),
            ownerTag: null,
        };
    }
    return null;
}

function leaseFileNameMatchesPidAndOwner(fileName: string, pid: number, ownerId: string) {
    const parsed = parseLeaseFileName(fileName);
    return parsed !== null && parsed.pid === pid && parsed.ownerTag === checkpointOwnerTag(ownerId);
}

async function isEntryActivelyLeased(rootRealPath: string, entryRealPath: string): Promise<boolean> {
    if (hasInProcessActiveEntryLease(entryRealPath)) {
        return true;
    }
    const entries = await readdir(entryRealPath, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
        if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            !entry.name.startsWith(CHECKPOINT_LEASE_PREFIX) ||
            !entry.name.endsWith(CHECKPOINT_LEASE_SUFFIX)
        ) {
            continue;
        }
        const parsedName = parseLeaseFileName(entry.name);
        if (parsedName === null) {
            continue;
        }
        const leaseRead = await readRegularFileNoFollow(rootRealPath, entryRealPath, entry.name);
        const parsed = leaseRead === null ? null : parseLockMetadata(leaseRead.bytes);
        const pid = parsed?.pid ?? parsedName.pid;
        if (isProcessAlive(pid)) {
            return true;
        }
        await unlink(join(entryRealPath, entry.name)).catch(() => undefined);
    }
    return false;
}

/**
 * Compute the cryptographic witness binding resumable conversion checkpoints
 * to the verified on-disk source PDF bytes, native tool identities, and
 * effective conversion options/scope signature.
 */
export function computeScanCleanupCheckpointWitness(input: {
    sourceSha256: string;
    request: IRunScanCleanupPipelineRequest;
    resolvedOptions: IRunScanCleanupPipelineRequest['options'];
    pageScope: TScanCleanupPageScope;
    documentPageCount: number;
    documentCanvas: unknown;
    losslessRun: boolean;
    rasterMaxPixels?: number | undefined;
    nativeToolIdentity?: Readonly<Record<string, string>> | undefined;
    assemblyBackend?: string | null | undefined;
    transportMode?: string | null | undefined;
    provenanceStampSupport?: boolean | null | undefined;
}): IScanCleanupCheckpointWitness {
    const signaturePayload = stripUndefined({
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        options: input.resolvedOptions,
        pageScope: serializePageScope(input.pageScope),
        documentPageCount: input.documentPageCount,
        documentCanvas: input.documentCanvas,
        losslessRun: input.losslessRun,
        rasterMaxPixels: input.rasterMaxPixels ?? null,
        nativeToolIdentity: input.nativeToolIdentity ?? null,
        assemblyBackend: input.assemblyBackend ?? null,
        transportMode: input.transportMode ?? null,
        provenanceStampSupport: input.provenanceStampSupport ?? null,
        placementAnchorSummary: input.request.placementAnchorSummary ?? null,
        outputModeRecommendations: input.request.outputModeRecommendations ?? null,
        softAlphaForegroundRecommendations: input.request.softAlphaForegroundRecommendations ?? null,
        layoutByPage: input.request.layoutByPage ?? null,
        documentPriorByPage: input.request.documentPriorByPage ?? null,
        pagePlanEvidenceByPage: input.request.pagePlanEvidenceByPage ?? null,
        placementAnchorsByPage: input.request.placementAnchorsByPage ?? null,
        sourcePageMetadataByPage: input.request.sourcePageMetadataByPage ?? null,
    });
    const optionsSignature = sha256Utf8Hex(canonicalScanCleanupJson(signaturePayload));
    const witnessId = sha256Utf8Hex(
        canonicalScanCleanupJson({
            schemaVersion: CHECKPOINT_SCHEMA_VERSION,
            sourceSha256: input.sourceSha256,
            optionsSignature,
        }),
    );
    return {
        sourceSha256: input.sourceSha256,
        optionsSignature,
        witnessId,
    };
}

export function computeScanCleanupBatchCheckpointSignature(input: {
    batchIndex: number;
    pageNumbers: readonly number[];
    boundedDetectionFields: unknown;
    nativeToolIdentity?: Readonly<Record<string, string>> | undefined;
    batchGeometry?: unknown;
    batchRasterFacts?: unknown;
}) {
    return sha256Utf8Hex(
        canonicalScanCleanupJson(
            stripUndefined({
                schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                batchIndex: input.batchIndex,
                pageNumbers: [...input.pageNumbers],
                boundedDetectionFields: input.boundedDetectionFields,
                nativeToolIdentity: input.nativeToolIdentity ?? null,
                batchGeometry: input.batchGeometry ?? null,
                batchRasterFacts: input.batchRasterFacts ?? null,
            }),
        ),
    );
}

export function computeScanCleanupRenderPlanSignature(input: {
    documentCanvas: unknown;
    rasterFormat: string;
    nativeToolIdentity?: Readonly<Record<string, string>> | undefined;
    pages: ReadonlyArray<{
        sourcePageIndex: number;
        analysisDpi?: number | null | undefined;
        options: unknown;
        documentPrior?: unknown;
        pdfPage?: unknown;
        hasTrustedMrc: boolean;
    }>;
}) {
    return sha256Utf8Hex(
        canonicalScanCleanupJson(
            stripUndefined({
                schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                documentCanvas: input.documentCanvas,
                rasterFormat: input.rasterFormat,
                nativeToolIdentity: input.nativeToolIdentity ?? null,
                pages: input.pages,
            }),
        ),
    );
}

function isAllowedStoredPageArtifactFileName(logicalFileName: string, storedFileName: string) {
    if (!isSafeSegment(storedFileName)) {
        return false;
    }
    if (storedFileName === logicalFileName) {
        return true;
    }
    return /^[0-9a-f]{12}-/.test(storedFileName) && storedFileName.slice(13) === logicalFileName;
}

function parseArtifactRecord(value: unknown): IScanCleanupCheckpointArtifactRecord | null {
    if (
        !isRecord(value) ||
        typeof value.fileName !== 'string' ||
        !isSafeSegment(value.fileName) ||
        typeof value.sizeBytes !== 'number' ||
        !Number.isSafeInteger(value.sizeBytes) ||
        value.sizeBytes < 0 ||
        !isSha256Hex(value.sha256)
    ) {
        return null;
    }
    if (value.storedFileName !== undefined) {
        if (typeof value.storedFileName !== 'string' || !isAllowedStoredPageArtifactFileName(value.fileName, value.storedFileName)) {
            return null;
        }
        return {
            fileName: value.fileName,
            storedFileName: value.storedFileName,
            sizeBytes: value.sizeBytes,
            sha256: value.sha256,
        };
    }
    return {
        fileName: value.fileName,
        sizeBytes: value.sizeBytes,
        sha256: value.sha256,
    };
}

function parseCheckpointManifest(value: unknown): IScanCleanupCheckpointManifest | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
        !isSha256Hex(value.witnessId) ||
        !isSha256Hex(value.sourceSha256) ||
        !isSha256Hex(value.optionsSignature) ||
        typeof value.sourcePath !== 'string' ||
        typeof value.documentPageCount !== 'number' ||
        !Number.isSafeInteger(value.documentPageCount) ||
        value.documentPageCount < 1 ||
        (value.mode !== 'batch' && value.mode !== 'streaming') ||
        typeof value.updatedAtMs !== 'number' ||
        !Number.isFinite(value.updatedAtMs) ||
        !isRecord(value.completedPages) ||
        !isRecord(value.completedBatches)
    ) {
        return null;
    }
    const completedPages: Record<string, IScanCleanupCheckpointedPageRecord> = {};
    for (const [key, rawPage] of Object.entries(value.completedPages)) {
        if (
            !isRecord(rawPage) ||
            typeof rawPage.pageNumber !== 'number' ||
            !Number.isSafeInteger(rawPage.pageNumber) ||
            rawPage.pageNumber < 1 ||
            !isSha256Hex(rawPage.planSignature) ||
            !Array.isArray(rawPage.artifacts)
        ) {
            return null;
        }
        const artifacts: IScanCleanupCheckpointArtifactRecord[] = [];
        for (const rawArtifact of rawPage.artifacts) {
            const parsed = parseArtifactRecord(rawArtifact);
            if (parsed === null || !isAllowedPageArtifactFileName(rawPage.pageNumber, parsed.fileName)) {
                return null;
            }
            artifacts.push(parsed);
        }
        completedPages[key] = {
            pageNumber: rawPage.pageNumber,
            planSignature: rawPage.planSignature,
            artifacts,
        };
    }
    const completedBatches: Record<string, IScanCleanupCheckpointedBatchRecord> = {};
    for (const [key, rawBatch] of Object.entries(value.completedBatches)) {
        if (
            !isRecord(rawBatch) ||
            typeof rawBatch.batchIndex !== 'number' ||
            !Number.isSafeInteger(rawBatch.batchIndex) ||
            rawBatch.batchIndex < 0 ||
            !isSha256Hex(rawBatch.batchSignature) ||
            typeof rawBatch.stateFileName !== 'string' ||
            !isSafeSegment(rawBatch.stateFileName) ||
            typeof rawBatch.stateSizeBytes !== 'number' ||
            !Number.isSafeInteger(rawBatch.stateSizeBytes) ||
            rawBatch.stateSizeBytes < 0 ||
            !isSha256Hex(rawBatch.stateSha256) ||
            (rawBatch.pdfFileName !== null && (typeof rawBatch.pdfFileName !== 'string' || !isSafeSegment(rawBatch.pdfFileName))) ||
            (rawBatch.pdfSizeBytes !== null &&
                (typeof rawBatch.pdfSizeBytes !== 'number' || !Number.isSafeInteger(rawBatch.pdfSizeBytes) || rawBatch.pdfSizeBytes < 0)) ||
            (rawBatch.pdfSha256 !== null && !isSha256Hex(rawBatch.pdfSha256)) ||
            (rawBatch.pdfFileName === null) !== (rawBatch.pdfSizeBytes === null) ||
            (rawBatch.pdfFileName === null) !== (rawBatch.pdfSha256 === null)
        ) {
            return null;
        }
        completedBatches[key] = {
            batchIndex: rawBatch.batchIndex,
            batchSignature: rawBatch.batchSignature,
            stateFileName: rawBatch.stateFileName,
            stateSizeBytes: rawBatch.stateSizeBytes,
            stateSha256: rawBatch.stateSha256,
            pdfFileName: rawBatch.pdfFileName,
            pdfSizeBytes: rawBatch.pdfSizeBytes,
            pdfSha256: rawBatch.pdfSha256,
        };
    }
    const documentInkPriors: Record<string, IScanCleanupCheckpointedInkPriorRecord> = {};
    if (value.documentInkPriors !== undefined) {
        if (!isRecord(value.documentInkPriors)) {
            return null;
        }
        for (const [key, rawPriorRecord] of Object.entries(value.documentInkPriors)) {
            if (!isRecord(rawPriorRecord) || !isSha256Hex(rawPriorRecord.planSignature)) {
                return null;
            }
            const parsedPrior = v.safeParse(NATIVE_SCAN_CLEANUP_DOCUMENT_INK_PRIOR_SCHEMA, rawPriorRecord.prior);
            if (!parsedPrior.success) {
                return null;
            }
            documentInkPriors[key] = {
                planSignature: rawPriorRecord.planSignature,
                prior: parsedPrior.output,
            };
        }
    }
    return {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        witnessId: value.witnessId,
        sourceSha256: value.sourceSha256,
        optionsSignature: value.optionsSignature,
        sourcePath: value.sourcePath,
        documentPageCount: value.documentPageCount,
        mode: value.mode,
        updatedAtMs: value.updatedAtMs,
        completedPages,
        completedBatches,
        documentInkPriors,
    };
}

function parseTextLayerInstruction(value: unknown): IScanCleanupTextLayerInstruction | null {
    if (
        !isRecord(value) ||
        typeof value.sourcePageIndex !== 'number' ||
        !Number.isSafeInteger(value.sourcePageIndex) ||
        value.sourcePageIndex < 0 ||
        typeof value.outputPageIndex !== 'number' ||
        !Number.isSafeInteger(value.outputPageIndex) ||
        value.outputPageIndex < 0 ||
        !Array.isArray(value.matrix) ||
        value.matrix.length !== 6 ||
        !value.matrix.every((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)) ||
        (value.linkOnly !== undefined && typeof value.linkOnly !== 'boolean')
    ) {
        return null;
    }
    return {
        sourcePageIndex: value.sourcePageIndex,
        outputPageIndex: value.outputPageIndex,
        matrix: [value.matrix[0]!, value.matrix[1]!, value.matrix[2]!, value.matrix[3]!, value.matrix[4]!, value.matrix[5]!],
        ...(value.linkOnly === undefined ? {} : {linkOnly: value.linkOnly}),
    };
}

const finiteNumberSchema = v.pipe(v.number(), v.finite());
const nonNegativeFiniteSchema = v.pipe(finiteNumberSchema, v.minValue(0));
const positiveFiniteSchema = v.pipe(finiteNumberSchema, v.gtValue(0));
const nonNegativeSafeIntSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveSafeIntSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const pointSchema = v.object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
});
const pixelRectSchema = v.object({
    xPx: finiteNumberSchema,
    yPx: finiteNumberSchema,
    widthPx: nonNegativeFiniteSchema,
    heightPx: nonNegativeFiniteSchema,
});
const affineRowSchema = v.tuple([finiteNumberSchema, finiteNumberSchema, finiteNumberSchema]);
const affineSchema = v.object({
    matrix: v.tuple([affineRowSchema, affineRowSchema, affineRowSchema]),
});
const dewarpMappingSchema = v.pipe(
    v.object({
        columns: v.pipe(positiveSafeIntSchema, v.minValue(2)),
        rows: v.pipe(positiveSafeIntSchema, v.minValue(2)),
        outputOrigin: pointSchema,
        outputWidth: positiveSafeIntSchema,
        outputHeight: positiveSafeIntSchema,
        outputToSource: v.array(pointSchema),
        sourceToOutput: v.array(pointSchema),
    }),
    v.check((mapping) => {
        const pointCount = mapping.columns * mapping.rows;
        return (
            Number.isSafeInteger(pointCount) && mapping.outputToSource.length === pointCount && mapping.sourceToOutput.length === pointCount
        );
    }),
);
const outputMappingSchema = v.object({
    sourcePage: positiveSafeIntSchema,
    half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
    outputOrdinal: v.nullable(positiveSafeIntSchema),
    rotationDegrees: v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS),
    excluded: v.boolean(),
    blank: v.boolean(),
});
const streamBytesSchema = v.pipe(
    v.object({
        composite: v.optional(nonNegativeSafeIntSchema),
        bilevel: v.optional(nonNegativeSafeIntSchema),
        background: v.optional(nonNegativeSafeIntSchema),
        foregroundMask: v.optional(nonNegativeSafeIntSchema),
        foregroundAlpha: v.optional(nonNegativeSafeIntSchema),
    }),
    v.transform((bytes): NonNullable<IScanCleanupOutputPageForSummary['streamBytes']> => ({
        ...(bytes.composite === undefined ? {} : {composite: bytes.composite}),
        ...(bytes.bilevel === undefined ? {} : {bilevel: bytes.bilevel}),
        ...(bytes.background === undefined ? {} : {background: bytes.background}),
        ...(bytes.foregroundMask === undefined ? {} : {foregroundMask: bytes.foregroundMask}),
        ...(bytes.foregroundAlpha === undefined ? {} : {foregroundAlpha: bytes.foregroundAlpha}),
    })),
);
const renderGeometrySchema = v.pipe(
    v.object({
        canvasHeightPx: positiveSafeIntSchema,
        canvasWidthPx: positiveSafeIntSchema,
        cropRect: pixelRectSchema,
        dewarpMapping: v.nullable(dewarpMappingSchema),
        dewarped: v.boolean(),
        foldClipLeftPx: v.optional(nonNegativeSafeIntSchema),
        foldClipRightPx: v.optional(nonNegativeSafeIntSchema),
        forwardTransform: v.nullable(affineSchema),
        inputHeightPx: positiveSafeIntSchema,
        inputWidthPx: positiveSafeIntSchema,
        intrinsicRasterHeightPx: v.optional(positiveSafeIntSchema),
        intrinsicRasterWidthPx: v.optional(positiveSafeIntSchema),
        matchedCanvasContentHeightPx: v.nullable(positiveSafeIntSchema),
        matchedCanvasContentWidthPx: v.nullable(positiveSafeIntSchema),
        matchedCanvasIntrinsicOverflowLeftPx: v.optional(nonNegativeSafeIntSchema),
        matchedCanvasIntrinsicOverflowRightPx: v.optional(nonNegativeSafeIntSchema),
        matchedCanvasIntrinsicOverflowTopPx: v.optional(nonNegativeSafeIntSchema),
        outputHeightPx: positiveSafeIntSchema,
        outputWidthPx: positiveSafeIntSchema,
        placementOffsetXPx: nonNegativeSafeIntSchema,
        placementOffsetYPx: nonNegativeSafeIntSchema,
        sourceRegion: pixelRectSchema,
    }),
    v.transform((geometry): NonNullable<IScanCleanupOutputPageForSummary['renderGeometry']> => ({
        canvasHeightPx: geometry.canvasHeightPx,
        canvasWidthPx: geometry.canvasWidthPx,
        cropRect: geometry.cropRect,
        dewarpMapping: geometry.dewarpMapping,
        dewarped: geometry.dewarped,
        forwardTransform: geometry.forwardTransform,
        inputHeightPx: geometry.inputHeightPx,
        inputWidthPx: geometry.inputWidthPx,
        matchedCanvasContentHeightPx: geometry.matchedCanvasContentHeightPx,
        matchedCanvasContentWidthPx: geometry.matchedCanvasContentWidthPx,
        outputHeightPx: geometry.outputHeightPx,
        outputWidthPx: geometry.outputWidthPx,
        placementOffsetXPx: geometry.placementOffsetXPx,
        placementOffsetYPx: geometry.placementOffsetYPx,
        sourceRegion: geometry.sourceRegion,
        ...(geometry.foldClipLeftPx === undefined ? {} : {foldClipLeftPx: geometry.foldClipLeftPx}),
        ...(geometry.foldClipRightPx === undefined ? {} : {foldClipRightPx: geometry.foldClipRightPx}),
        ...(geometry.intrinsicRasterHeightPx === undefined ? {} : {intrinsicRasterHeightPx: geometry.intrinsicRasterHeightPx}),
        ...(geometry.intrinsicRasterWidthPx === undefined ? {} : {intrinsicRasterWidthPx: geometry.intrinsicRasterWidthPx}),
        ...(geometry.matchedCanvasIntrinsicOverflowLeftPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowLeftPx: geometry.matchedCanvasIntrinsicOverflowLeftPx}),
        ...(geometry.matchedCanvasIntrinsicOverflowRightPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowRightPx: geometry.matchedCanvasIntrinsicOverflowRightPx}),
        ...(geometry.matchedCanvasIntrinsicOverflowTopPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowTopPx: geometry.matchedCanvasIntrinsicOverflowTopPx}),
    })),
);
const representationPageSchema = v.pipe(
    v.object({
        outputPageNumber: positiveSafeIntSchema,
        sourcePageNumber: positiveSafeIntSchema,
        semanticMode: v.picklist(SCAN_CLEANUP_OUTPUT_MODES),
        representation: v.pipe(v.string(), v.minLength(1)),
        preservationReason: v.nullable(v.string()),
        sourceDpi: v.nullable(positiveFiniteSchema),
        sourceBackgroundDpi: v.nullable(positiveFiniteSchema),
        renderDpi: positiveFiniteSchema,
        illuminationNormalized: v.boolean(),
        textToneApplied: v.boolean(),
        binarizationMode: v.nullable(v.string()),
        half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
        outputOrdinal: positiveSafeIntSchema,
        rotationDegrees: v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS),
        excluded: v.boolean(),
        blank: v.boolean(),
        streamBytes: v.optional(streamBytesSchema),
        renderGeometry: v.optional(renderGeometrySchema),
    }),
    v.transform(({streamBytes, renderGeometry, ...page}): IScanCleanupOutputPageForSummary => ({
        ...page,
        ...(streamBytes === undefined ? {} : {streamBytes}),
        ...(renderGeometry === undefined ? {} : {renderGeometry}),
    })),
);
const representationReportSchema = v.pipe(
    v.object({
        schemaVersion: v.literal(1),
        sourceBytes: nonNegativeFiniteSchema,
        outputBytes: nonNegativeFiniteSchema,
        outputToSourceByteRatio: nonNegativeFiniteSchema,
        compactSourceBudget: v.unknown(),
        outputMappings: v.array(outputMappingSchema),
        pages: v.array(representationPageSchema),
        outputMappingsSidecarPath: v.optional(v.string()),
        pagesSidecarPath: v.optional(v.string()),
    }),
    v.transform(({outputMappingsSidecarPath, pagesSidecarPath, ...report}): IScanCleanupRepresentationReport => ({
        ...report,
        ...(outputMappingsSidecarPath === undefined ? {} : {outputMappingsSidecarPath}),
        ...(pagesSidecarPath === undefined ? {} : {pagesSidecarPath}),
    })),
);
const emptyRepresentationReportSchema = v.pipe(
    v.object({
        schemaVersion: v.optional(v.literal(1)),
        sourceBytes: v.optional(nonNegativeFiniteSchema),
        outputBytes: v.optional(nonNegativeFiniteSchema),
        outputToSourceByteRatio: v.optional(nonNegativeFiniteSchema),
        compactSourceBudget: v.optional(v.unknown()),
        outputMappings: v.array(outputMappingSchema),
        pages: v.pipe(v.array(representationPageSchema), v.length(0)),
        outputMappingsSidecarPath: v.optional(v.string()),
        pagesSidecarPath: v.optional(v.string()),
    }),
    v.transform(
        ({
            schemaVersion,
            sourceBytes,
            outputBytes,
            outputToSourceByteRatio,
            compactSourceBudget,
            outputMappings,
            pages,
            outputMappingsSidecarPath,
            pagesSidecarPath,
        }): IScanCleanupRepresentationReport => ({
            schemaVersion: schemaVersion ?? 1,
            sourceBytes: sourceBytes ?? 0,
            outputBytes: outputBytes ?? 0,
            outputToSourceByteRatio: outputToSourceByteRatio ?? 0,
            compactSourceBudget: compactSourceBudget ?? null,
            outputMappings,
            pages,
            ...(outputMappingsSidecarPath === undefined ? {} : {outputMappingsSidecarPath}),
            ...(pagesSidecarPath === undefined ? {} : {pagesSidecarPath}),
        }),
    ),
);

function hasValidOutputMappingContext(
    mapping: IScanCleanupOutputMapping,
    expectedPageSet: ReadonlySet<number>,
    outputPages: number,
): boolean {
    return (
        expectedPageSet.has(mapping.sourcePage) &&
        (mapping.outputOrdinal === null || (mapping.outputOrdinal >= 1 && mapping.outputOrdinal <= outputPages))
    );
}

function validateBatchState(
    value: unknown,
    expectedBatchIndex: number,
    expectedBatchSignature: string,
    expectedPageNumbers: readonly number[],
    expectedHasPdf: boolean,
    expectedPdfSizeBytes: number | null,
): IScanCleanupCheckpointedBatchState | null {
    if (expectedPageNumbers.length === 0) {
        return null;
    }
    const expectedPageSet = new Set(expectedPageNumbers);
    if (
        !isRecord(value) ||
        value.batchIndex !== expectedBatchIndex ||
        value.batchSignature !== expectedBatchSignature ||
        value.firstPageNumber !== expectedPageNumbers[0] ||
        typeof value.firstPageNumber !== 'number' ||
        !Number.isSafeInteger(value.firstPageNumber) ||
        value.firstPageNumber < 1 ||
        value.hasBatchPdf !== expectedHasPdf ||
        value.batchPdfSizeBytes !== expectedPdfSizeBytes ||
        !Array.isArray(value.sourceTextPages) ||
        !Array.isArray(value.skippedNonAffine) ||
        !value.skippedNonAffine.every(
            (page): page is number => typeof page === 'number' && Number.isSafeInteger(page) && expectedPageSet.has(page),
        )
    ) {
        return null;
    }
    const parsedSummary = v.safeParse(SCAN_CLEANUP_SUMMARY_SCHEMA, value.summary, {abortEarly: true});
    if (!parsedSummary.success) {
        return null;
    }
    const summary = parsedSummary.output;
    if (summary.inputPages !== expectedPageNumbers.length) {
        return null;
    }
    // Enforce strict biconditional agreement between batch PDF presence and
    // summary.outputPages: non-empty batches must carry a non-empty PDF, and
    // empty batches must not carry a PDF.
    const expectsPdf = summary.outputPages > 0;
    if (expectedHasPdf !== expectsPdf) {
        return null;
    }
    if (expectsPdf && (expectedPdfSizeBytes === null || expectedPdfSizeBytes <= 0)) {
        return null;
    }
    if (!expectsPdf && expectedPdfSizeBytes !== null) {
        return null;
    }
    const sourceTextPages: IScanCleanupTextLayerInstruction[] = [];
    for (const rawInstruction of value.sourceTextPages) {
        const parsedInstruction = parseTextLayerInstruction(rawInstruction);
        if (
            parsedInstruction === null ||
            !expectedPageSet.has(parsedInstruction.sourcePageIndex + 1) ||
            parsedInstruction.outputPageIndex < 0 ||
            parsedInstruction.outputPageIndex >= summary.outputPages
        ) {
            return null;
        }
        sourceTextPages.push(parsedInstruction);
    }
    let representationReport: IScanCleanupRepresentationReport | null = null;
    if (value.representationReport !== null) {
        const parsedReport = v.safeParse(
            summary.outputPages === 0 ? emptyRepresentationReportSchema : representationReportSchema,
            value.representationReport,
            {abortEarly: true},
        );
        if (!parsedReport.success) {
            return null;
        }
        const report = parsedReport.output;
        if (
            report.pages.length !== summary.outputPages ||
            !report.outputMappings.every((mapping) => hasValidOutputMappingContext(mapping, expectedPageSet, summary.outputPages)) ||
            !report.pages.every(
                (page) =>
                    expectedPageSet.has(page.sourcePageNumber) &&
                    page.outputPageNumber <= summary.outputPages &&
                    page.outputOrdinal <= summary.outputPages,
            )
        ) {
            return null;
        }
        const mappedOutputCount = report.outputMappings.filter((mapping) => mapping.outputOrdinal !== null).length;
        if (mappedOutputCount !== summary.outputPages) {
            return null;
        }
        representationReport = report;
    } else if (summary.outputPages > 0) {
        return null;
    }
    let provenanceStamp: TScanCleanupProvenanceStamp | null = null;
    if (value.provenanceStamp !== null) {
        const parsedStamp = v.safeParse(SCAN_CLEANUP_PROVENANCE_STAMP_SCHEMA, value.provenanceStamp, {abortEarly: true});
        if (!parsedStamp.success) {
            return null;
        }
        const stamp = parsedStamp.output;
        if (
            !stamp.effectiveOptions.perSourcePage.every((entry) => expectedPageSet.has(entry.sourcePage)) ||
            !stamp.pagePlanDigests.every((entry) => expectedPageSet.has(entry.sourcePage)) ||
            !stamp.outputMappings.every((mapping) => hasValidOutputMappingContext(mapping, expectedPageSet, summary.outputPages)) ||
            stamp.outputMappings.filter((mapping) => mapping.outputOrdinal !== null).length !== summary.outputPages
        ) {
            return null;
        }
        provenanceStamp = stamp;
    } else if (summary.outputPages > 0) {
        return null;
    }
    return {
        batchIndex: expectedBatchIndex,
        firstPageNumber: value.firstPageNumber,
        batchSignature: expectedBatchSignature,
        hasBatchPdf: expectedHasPdf,
        batchPdfSizeBytes: expectedPdfSizeBytes,
        summary,
        representationReport,
        provenanceStamp,
        sourceTextPages,
        skippedNonAffine: [...value.skippedNonAffine],
    };
}

async function writeFileAtomic(targetPath: string, content: string, renameFn: typeof rename) {
    const tempPath = `${targetPath}.${randomUUID()}${CHECKPOINT_TEMP_SUFFIX}`;
    try {
        await writeFile(tempPath, content, 'utf8');
        await renameFn(tempPath, targetPath);
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    }
}

async function copyFileAtomicAndDigest(
    sourcePath: string,
    targetPath: string,
    renameFn: typeof rename,
): Promise<{
    sizeBytes: number;
    sha256: string;
}> {
    const tempPath = `${targetPath}.${randomUUID()}${CHECKPOINT_TEMP_SUFFIX}`;
    try {
        await copyFile(sourcePath, tempPath);
        const handle = await open(tempPath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
        let sizeBytes = 0;
        let sha256: string;
        try {
            const hash = createHash('sha256');
            const buffer = Buffer.allocUnsafe(64 * 1024);
            while (true) {
                const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0) {
                    break;
                }
                sizeBytes += bytesRead;
                hash.update(buffer.subarray(0, bytesRead));
            }
            sha256 = hash.digest('hex');
        } finally {
            await handle.close();
        }
        await renameFn(tempPath, targetPath);
        return {
            sizeBytes,
            sha256,
        };
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    }
}

async function removeTempFilesInDirectory(rootRealPath: string, directory: string) {
    const resolvedDir = await realpath(directory).catch(() => null);
    if (resolvedDir === null || !isWithinRealRoot(rootRealPath, resolvedDir)) {
        return;
    }
    let entries;
    try {
        entries = await readdir(resolvedDir, {withFileTypes: true});
    } catch {
        return;
    }
    await Promise.all(
        entries.map(async (entry) => {
            if (!isSafeSegment(entry.name) || entry.isSymbolicLink()) {
                return;
            }
            const fullPath = join(resolvedDir, entry.name);
            if (entry.isFile() && entry.name.endsWith(CHECKPOINT_TEMP_SUFFIX)) {
                await unlink(fullPath).catch(() => undefined);
                return;
            }
            if (entry.isDirectory()) {
                await removeTempFilesInDirectory(rootRealPath, fullPath);
            }
        }),
    );
}

function pageRecordKey(pageNumber: number, scopeKey?: string) {
    return scopeKey === undefined ? String(pageNumber) : `${scopeKey}:${String(pageNumber)}`;
}

function inkPriorScopeKey(scopeKey?: string) {
    return scopeKey ?? '__default__';
}

function pageRelativeSegments(pageNumber: number, scopeKey?: string): string[] {
    if (scopeKey !== undefined && !isSafeSegment(scopeKey)) {
        throw new Error(`Unsafe scan cleanup checkpoint scope key: ${scopeKey}`);
    }
    return scopeKey === undefined
        ? [CHECKPOINT_ARTIFACTS_DIRNAME, `page-${String(pageNumber)}`]
        : [CHECKPOINT_ARTIFACTS_DIRNAME, scopeKey, `page-${String(pageNumber)}`];
}

function manifestMatchesWitness(
    manifest: IScanCleanupCheckpointManifest,
    witness: IScanCleanupCheckpointWitness,
    documentPageCount: number,
    mode: 'batch' | 'streaming',
) {
    return (
        manifest.witnessId === witness.witnessId &&
        manifest.sourceSha256 === witness.sourceSha256 &&
        manifest.optionsSignature === witness.optionsSignature &&
        manifest.documentPageCount === documentPageCount &&
        manifest.mode === mode
    );
}

/**
 * Safely reclaim all lock and lease artifacts owned by `(process.pid, ownerId)`
 * after the owning worker thread has genuinely exited.
 *
 * Uses the same token-keyed serialized reclamation primitive as dead-PID
 * recovery so concurrent contenders cannot race or unlink a successor's live
 * lock. Never deletes valid checkpoint entries or artifacts belonging to other
 * live owners.
 */
export async function reclaimScanCleanupCheckpointOwner(
    checkpointDir: string,
    ownerId: string,
): Promise<{
    reclaimedDirLock: boolean;
    reclaimedReclaimLocks: number;
    reclaimedLeases: number;
}> {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new Error('Scan cleanup checkpoint ownerId must be a non-empty string');
    }
    const rootRealPath = await resolveCanonicalCheckpointRootIfExists(checkpointDir);
    if (rootRealPath === null) {
        return {
            reclaimedDirLock: false,
            reclaimedReclaimLocks: 0,
            reclaimedLeases: 0,
        };
    }
    const reclaimerOwnerId = `reclaimer-${randomUUID()}`;
    const reclaimedReclaimLocks = await sweepDeadReclaimLocks(rootRealPath, reclaimerOwnerId, ownerId);
    let reclaimedDirLock = false;
    const lockPath = join(rootRealPath, CHECKPOINT_DIR_LOCK_FILENAME);
    for (let attempt = 0; attempt < MAX_RECLAIM_LOCK_DEPTH; attempt += 1) {
        const lockLinkStats = await lstat(lockPath).catch(() => null);
        if (lockLinkStats === null) {
            break;
        }
        if (lockLinkStats.isSymbolicLink()) {
            throw new Error(`Scan cleanup checkpoint lock is a symbolic link: ${lockPath}`);
        }
        if (!lockLinkStats.isFile()) {
            break;
        }
        const lockRead = await readRegularFileNoFollow(rootRealPath, rootRealPath, CHECKPOINT_DIR_LOCK_FILENAME);
        if (lockRead === null) {
            break;
        }
        const parsed = parseLockMetadata(lockRead.bytes);
        if (!isLockMetadataReclaimable(parsed, lockRead.mtimeMs, ownerId)) {
            break;
        }
        reclaimedDirLock = await tryReclaimLockFileSerialized({
            rootRealPath,
            targetFileName: CHECKPOINT_DIR_LOCK_FILENAME,
            targetDev: lockRead.dev,
            targetIno: lockRead.ino,
            targetSha256: lockRead.sha256,
            targetMeta: parsed,
            callerOwnerId: reclaimerOwnerId,
            confirmedDeadOwnerId: ownerId,
        });
        if (reclaimedDirLock) {
            break;
        }
    }
    const reclaimedLeases = await withCheckpointDirLock(
        rootRealPath,
        async () => {
            clearInProcessOwnerLeasesUnderRoot(rootRealPath, ownerId);
            let removedCount = 0;
            const entries = await readdir(rootRealPath, {withFileTypes: true}).catch(() => []);
            for (const entry of entries) {
                if (
                    !isSafeSegment(entry.name) ||
                    entry.isSymbolicLink() ||
                    !entry.isDirectory() ||
                    !entry.name.startsWith(CHECKPOINT_ENTRY_PREFIX)
                ) {
                    continue;
                }
                const entryRealPath = await tryResolveContainedRealDirectory(rootRealPath, [entry.name]);
                if (entryRealPath === null) {
                    continue;
                }
                // Holding the directory lock ensures no other writer is staging
                // temp files inside `entryRealPath`, so any `.tmp` left behind by
                // an interrupted lease or manifest write can be cleaned safely.
                await removeTempFilesInDirectory(rootRealPath, entryRealPath);
                const entryFiles = await readdir(entryRealPath, {withFileTypes: true}).catch(() => []);
                for (const leaseEntry of entryFiles) {
                    if (
                        !isSafeSegment(leaseEntry.name) ||
                        leaseEntry.isSymbolicLink() ||
                        !leaseEntry.isFile() ||
                        !leaseEntry.name.startsWith(CHECKPOINT_LEASE_PREFIX) ||
                        !leaseEntry.name.endsWith(CHECKPOINT_LEASE_SUFFIX)
                    ) {
                        continue;
                    }
                    const leaseRead = await readRegularFileNoFollow(rootRealPath, entryRealPath, leaseEntry.name);
                    if (leaseRead === null) {
                        continue;
                    }
                    const parsed = parseLockMetadata(leaseRead.bytes);
                    const ownedByTarget =
                        parsed !== null
                            ? parsed.pid === process.pid && parsed.ownerId === ownerId
                            : leaseFileNameMatchesPidAndOwner(leaseEntry.name, process.pid, ownerId);
                    if (!ownedByTarget) {
                        continue;
                    }
                    const leasePath = join(entryRealPath, leaseEntry.name);
                    const currentStats = await lstat(leasePath).catch(() => null);
                    if (
                        currentStats !== null &&
                        !currentStats.isSymbolicLink() &&
                        currentStats.isFile() &&
                        currentStats.dev === leaseRead.dev &&
                        currentStats.ino === leaseRead.ino
                    ) {
                        await unlink(leasePath).catch(() => undefined);
                        removedCount += 1;
                    }
                }
            }
            return removedCount;
        },
        {ownerId: reclaimerOwnerId},
    );

    return {
        reclaimedDirLock,
        reclaimedReclaimLocks,
        reclaimedLeases,
    };
}

/**
 * Safely reclaim a completed checkpoint entry after the owning host service
 * crosses its commit boundary. Respects symlink containment and active leases
 * from any concurrent runs sharing the same witness.
 */
export async function reclaimScanCleanupCheckpoint(checkpointDir: string, entryDir: string, ownerId?: string): Promise<boolean> {
    const rootRealPath = await resolveCanonicalCheckpointRoot(checkpointDir);
    const entryName = basename(entryDir);
    if (!isSafeSegment(entryName) || !entryName.startsWith(CHECKPOINT_ENTRY_PREFIX)) {
        return false;
    }
    const candidatePath = join(rootRealPath, entryName);
    if (resolve(entryDir) !== resolve(join(checkpointDir, entryName)) && resolve(entryDir) !== candidatePath) {
        return false;
    }
    return withCheckpointDirLock(
        rootRealPath,
        async () => {
            const entryRealPath = await tryResolveContainedRealDirectory(rootRealPath, [entryName]);
            if (entryRealPath === null) {
                return false;
            }
            if (await isEntryActivelyLeased(rootRealPath, entryRealPath)) {
                return false;
            }
            await safeRemoveContainedDirectoryTree(rootRealPath, entryRealPath);
            return true;
        },
        {ownerId},
    );
}

/**
 * Open or initialize a witness-bound conversion checkpoint under `checkpointDir`.
 *
 * Uses full 64-hex witness directory names, exclusive directory locking, active
 * entry leases (protecting concurrent runs from invalidating each other), and
 * merge-on-write manifest persistence.
 */
export async function openScanCleanupConversionCheckpoint(input: {
    checkpointDir: string;
    sourcePdfPath: string;
    witness: IScanCleanupCheckpointWitness;
    documentPageCount: number;
    mode: 'batch' | 'streaming';
    log: TScanCleanupLog;
    fileSystem?: IScanCleanupCheckpointFileSystemHooks;
    lockTimeoutMs?: number;
    ownerId?: string;
}): Promise<IScanCleanupConversionCheckpoint> {
    if (!isSha256Hex(input.witness.witnessId) || !isSha256Hex(input.witness.sourceSha256) || !isSha256Hex(input.witness.optionsSignature)) {
        throw new Error('Scan cleanup checkpoint witness digests must be 64-character SHA-256 hex strings');
    }
    const renameFn = input.fileSystem?.rename ?? rename;
    const ownerId = input.ownerId ?? randomUUID();
    const lockOptions: IWithCheckpointDirLockOptions = {
        lockTimeoutMs: input.lockTimeoutMs,
        ownerId,
        hooks: input.fileSystem,
    };
    const resolvedSourcePath = resolve(input.sourcePdfPath);
    const rootRealPath = await resolveCanonicalCheckpointRoot(input.checkpointDir);

    const expectedEntryName = `${CHECKPOINT_ENTRY_PREFIX}${input.witness.witnessId}`;
    const handleId = randomUUID();
    const ownerTag = checkpointOwnerTag(ownerId);
    const leaseFileName = `${CHECKPOINT_LEASE_PREFIX}${String(process.pid)}-${ownerTag}-${handleId}${CHECKPOINT_LEASE_SUFFIX}`;

    const opened = await withCheckpointDirLock(
        rootRealPath,
        async () => {
            let existingManifest: IScanCleanupCheckpointManifest | null = null;
            const entries = await readdir(rootRealPath, {withFileTypes: true}).catch(() => []);
            for (const entry of entries) {
                if (!isSafeSegment(entry.name)) {
                    continue;
                }
                const fullPath = join(rootRealPath, entry.name);
                if (entry.isSymbolicLink()) {
                    if (entry.name === expectedEntryName) {
                        throw new Error(`Scan cleanup checkpoint entry is a symbolic link: ${fullPath}`);
                    }
                    continue;
                }
                if (entry.isFile() && entry.name.endsWith(CHECKPOINT_TEMP_SUFFIX)) {
                    const isLockTempFile =
                        entry.name.startsWith(`${CHECKPOINT_DIR_LOCK_FILENAME}.`) || entry.name.startsWith(CHECKPOINT_RECLAIM_LOCK_PREFIX);
                    if (isLockTempFile) {
                        const tempRead = await readRegularFileNoFollow(rootRealPath, rootRealPath, entry.name);
                        if (tempRead === null) {
                            continue;
                        }
                        const parsed = parseLockMetadata(tempRead.bytes);
                        if (!isLockMetadataReclaimable(parsed, tempRead.mtimeMs)) {
                            continue;
                        }
                    }
                    await unlink(fullPath).catch(() => undefined);
                    continue;
                }
                if (!entry.isDirectory() || !entry.name.startsWith(CHECKPOINT_ENTRY_PREFIX)) {
                    continue;
                }
                const candidateRealDir = await tryResolveContainedRealDirectory(rootRealPath, [entry.name]);
                if (candidateRealDir === null) {
                    continue;
                }
                const active = await isEntryActivelyLeased(rootRealPath, candidateRealDir);
                const manifestRead = await readRegularFileNoFollow(rootRealPath, candidateRealDir, CHECKPOINT_MANIFEST_FILENAME);
                let parsed: IScanCleanupCheckpointManifest | null = null;
                if (manifestRead !== null) {
                    try {
                        parsed = parseCheckpointManifest(JSON.parse(manifestRead.bytes.toString('utf8')) as unknown);
                    } catch {
                        parsed = null;
                    }
                }
                if (parsed === null) {
                    if (!active) {
                        await safeRemoveContainedDirectoryTree(rootRealPath, candidateRealDir).catch(() => undefined);
                        input.log('debug', `Removed corrupt scan cleanup checkpoint directory ${entry.name}`);
                    }
                    continue;
                }
                if (
                    entry.name === expectedEntryName &&
                    manifestMatchesWitness(parsed, input.witness, input.documentPageCount, input.mode)
                ) {
                    existingManifest = parsed;
                    continue;
                }
                const sameSourcePath = parsed.sourcePath === resolvedSourcePath;
                const sameSourceContent = parsed.sourceSha256 === input.witness.sourceSha256;
                if ((sameSourcePath || sameSourceContent || entry.name === expectedEntryName) && !active) {
                    const reason =
                        parsed.sourceSha256 !== input.witness.sourceSha256
                            ? 'source content changed'
                            : parsed.optionsSignature !== input.witness.optionsSignature
                              ? 'scan cleanup options changed'
                              : 'conversion plan changed';
                    await safeRemoveContainedDirectoryTree(rootRealPath, candidateRealDir).catch(() => undefined);
                    input.log('debug', `Invalidated stale scan cleanup checkpoint ${entry.name} (${reason})`);
                }
            }

            const entryRealPath = await assertContainedRealDirectory(rootRealPath, [expectedEntryName], true);
            const artifactsRealPath = await assertContainedRealDirectory(
                rootRealPath,
                [expectedEntryName, CHECKPOINT_ARTIFACTS_DIRNAME],
                true,
            );
            const manifestPath = join(entryRealPath, CHECKPOINT_MANIFEST_FILENAME);
            const manifestStat = await lstat(manifestPath).catch(() => null);
            if (manifestStat !== null && manifestStat.isSymbolicLink()) {
                throw new Error(`Scan cleanup checkpoint manifest is a symbolic link: ${manifestPath}`);
            }

            const resumed = existingManifest !== null;
            const manifest: IScanCleanupCheckpointManifest = existingManifest ?? {
                schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                witnessId: input.witness.witnessId,
                sourceSha256: input.witness.sourceSha256,
                optionsSignature: input.witness.optionsSignature,
                sourcePath: resolvedSourcePath,
                documentPageCount: input.documentPageCount,
                mode: input.mode,
                updatedAtMs: Date.now(),
                completedPages: {},
                completedBatches: {},
                documentInkPriors: {},
            };
            manifest.sourcePath = resolvedSourcePath;

            // Acquire active entry lease atomically via writeFileAtomic before
            // releasing the directory lock so a worker terminated mid-write never
            // leaves a 0-byte `.lease-*.lock` file, and the owner tag in the lease
            // filename ensures reclamation can still identify ownership even on a
            // truncated file. Any initialization failure after acquiring the lease
            // rolls both the lease file and in-process refcount back before rethrowing.
            const leasePath = join(entryRealPath, leaseFileName);
            const existingLease = await lstat(leasePath).catch(() => null);
            if (existingLease !== null && existingLease.isSymbolicLink()) {
                throw new Error(`Scan cleanup checkpoint lease is a symbolic link: ${leasePath}`);
            }
            let inProcessLeaseAcquired = false;
            try {
                await writeFileAtomic(
                    leasePath,
                    JSON.stringify({
                        pid: process.pid,
                        ownerId,
                        handleId,
                        acquiredAtMs: Date.now(),
                    }),
                    renameFn,
                );
                incrementInProcessEntryLease(entryRealPath, ownerId);
                inProcessLeaseAcquired = true;

                await removeTempFilesInDirectory(rootRealPath, entryRealPath);
                if (!resumed) {
                    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, renameFn);
                }
            } catch (error) {
                await unlink(leasePath).catch(() => undefined);
                if (inProcessLeaseAcquired) {
                    decrementInProcessEntryLease(entryRealPath, ownerId);
                }
                throw error;
            }
            return {
                entryRealPath,
                artifactsRealPath,
                manifestPath,
                leasePath,
                manifest,
                resumed,
            };
        },
        lockOptions,
    );

    const {entryRealPath, manifestPath, leasePath, resumed} = opened;
    let leaseReleased = false;
    const releaseLease = async () => {
        if (leaseReleased) {
            return;
        }
        leaseReleased = true;
        await unlink(leasePath).catch(() => undefined);
        decrementInProcessEntryLease(entryRealPath, ownerId);
    };

    const readCurrentManifestLocked = async (): Promise<IScanCleanupCheckpointManifest> => {
        const manifestRead = await readRegularFileNoFollow(rootRealPath, entryRealPath, CHECKPOINT_MANIFEST_FILENAME);
        if (manifestRead !== null) {
            try {
                const parsed = parseCheckpointManifest(JSON.parse(manifestRead.bytes.toString('utf8')) as unknown);
                if (parsed !== null && manifestMatchesWitness(parsed, input.witness, input.documentPageCount, input.mode)) {
                    return parsed;
                }
            } catch {
                // Fall through to fresh manifest bound to this witness.
            }
        }
        return {
            schemaVersion: CHECKPOINT_SCHEMA_VERSION,
            witnessId: input.witness.witnessId,
            sourceSha256: input.witness.sourceSha256,
            optionsSignature: input.witness.optionsSignature,
            sourcePath: resolvedSourcePath,
            documentPageCount: input.documentPageCount,
            mode: input.mode,
            updatedAtMs: Date.now(),
            completedPages: {},
            completedBatches: {},
            documentInkPriors: {},
        };
    };

    const verifyPageCheckpointComplete = async (
        pageNumber: number,
        record: IScanCleanupCheckpointedPageRecord,
        pageRealDir: string,
    ): Promise<boolean> => {
        if (record.artifacts.length === 0) {
            return false;
        }
        const seenNames = new Set<string>();
        const jsonContentsByName = new Map<string, string>();
        for (const artifact of record.artifacts) {
            const storedFileName = artifact.storedFileName ?? artifact.fileName;
            if (
                !isAllowedPageArtifactFileName(pageNumber, artifact.fileName) ||
                !isAllowedStoredPageArtifactFileName(artifact.fileName, storedFileName) ||
                seenNames.has(artifact.fileName)
            ) {
                return false;
            }
            seenNames.add(artifact.fileName);
            if (artifact.fileName.endsWith('.json')) {
                const read = await readRegularFileNoFollow(rootRealPath, pageRealDir, storedFileName);
                if (read === null || read.sizeBytes !== artifact.sizeBytes || read.sha256 !== artifact.sha256) {
                    return false;
                }
                jsonContentsByName.set(artifact.fileName, read.bytes.toString('utf8'));
            } else {
                const digest = await hashRegularFileNoFollow(rootRealPath, pageRealDir, storedFileName);
                if (digest === null || digest.sizeBytes !== artifact.sizeBytes || digest.sha256 !== artifact.sha256) {
                    return false;
                }
            }
        }

        const pageMetadataFileName = `clean-${String(pageNumber)}-page.json`;
        const pageMetadataText = jsonContentsByName.get(pageMetadataFileName);
        if (pageMetadataText === undefined) {
            return false;
        }
        let pageMetadata;
        try {
            pageMetadata = decodeNativeScanCleanupPageMetadataJson(pageMetadataText);
        } catch {
            return false;
        }
        if (pageMetadata.excluded) {
            return true;
        }
        if (pageMetadata.outputCount < 0 || pageMetadata.outputCount > 2) {
            return false;
        }
        for (let outputIndex = 0; outputIndex < pageMetadata.outputCount; outputIndex += 1) {
            const outputMetaName = `clean-${String(pageNumber)}-${String(outputIndex)}.json`;
            const outputMetaText = jsonContentsByName.get(outputMetaName);
            if (outputMetaText === undefined) {
                return false;
            }
            let outputMeta;
            try {
                outputMeta = decodeNativeScanCleanupOutputMetadataJson(outputMetaText);
            } catch {
                return false;
            }
            if (outputMeta.layeredWritten) {
                if (!seenNames.has(`clean-${String(pageNumber)}-${String(outputIndex)}-background.ppm`)) {
                    return false;
                }
                const expectedForeground =
                    outputMeta.layeredForegroundKind === 'soft-alpha'
                        ? `clean-${String(pageNumber)}-${String(outputIndex)}-alpha.pgm`
                        : `clean-${String(pageNumber)}-${String(outputIndex)}-mask.pbm`;
                if (!seenNames.has(expectedForeground)) {
                    return false;
                }
            } else if (outputMeta.bilevelWritten) {
                if (!seenNames.has(`clean-${String(pageNumber)}-${String(outputIndex)}.pbm`)) {
                    return false;
                }
            } else if (!seenNames.has(`clean-${String(pageNumber)}-${String(outputIndex)}.png`)) {
                return false;
            }
        }
        return true;
    };

    return {
        witness: input.witness,
        entryDir: entryRealPath,
        resumed,
        getDocumentInkPrior(expectedPlanSignature, scopeKey) {
            return withCheckpointDirLock(
                rootRealPath,
                async () => {
                    const current = await readCurrentManifestLocked();
                    const priorRecord = current.documentInkPriors[inkPriorScopeKey(scopeKey)];
                    if (priorRecord === undefined || priorRecord.planSignature !== expectedPlanSignature) {
                        return null;
                    }
                    return priorRecord.prior;
                },
                lockOptions,
            );
        },
        restoreCompletedPages(scratchDir, expectedPageNumbers, expectedPlanSignature, scopeKey) {
            return withCheckpointDirLock(
                rootRealPath,
                async () => {
                    const current = await readCurrentManifestLocked();
                    const restored = new Set<number>();
                    let manifestDirty = false;
                    for (const pageNumber of expectedPageNumbers) {
                        const key = pageRecordKey(pageNumber, scopeKey);
                        const record = current.completedPages[key];
                        if (record === undefined || record.pageNumber !== pageNumber || record.planSignature !== expectedPlanSignature) {
                            continue;
                        }
                        const relativeSegs = pageRelativeSegments(pageNumber, scopeKey);
                        const pageRealDir = await tryResolveContainedRealDirectory(rootRealPath, [expectedEntryName, ...relativeSegs]);
                        if (pageRealDir === null) {
                            delete current.completedPages[key];
                            manifestDirty = true;
                            continue;
                        }
                        const completeAndValid = await verifyPageCheckpointComplete(pageNumber, record, pageRealDir);
                        if (!completeAndValid) {
                            delete current.completedPages[key];
                            manifestDirty = true;
                            await safeRemoveContainedDirectoryTree(rootRealPath, pageRealDir).catch(() => undefined);
                            continue;
                        }
                        const restoredScratchPaths: string[] = [];
                        try {
                            for (const artifact of record.artifacts) {
                                const storedFileName = artifact.storedFileName ?? artifact.fileName;
                                const destinationPath = join(scratchDir, artifact.fileName);
                                const copied = await streamCopyRegularFileNoFollowToTarget(
                                    rootRealPath,
                                    pageRealDir,
                                    storedFileName,
                                    destinationPath,
                                    renameFn,
                                    {
                                        expectedSizeBytes: artifact.sizeBytes,
                                        expectedSha256: artifact.sha256,
                                    },
                                );
                                if (copied !== 'ok') {
                                    throw new Error(`Checkpoint artifact failed integrity verification: ${artifact.fileName}`);
                                }
                                restoredScratchPaths.push(destinationPath);
                            }
                            restored.add(pageNumber);
                        } catch (error) {
                            await Promise.all(restoredScratchPaths.map((path) => rm(path, {force: true}).catch(() => undefined)));
                            input.log(
                                'warn',
                                `Could not restore scan cleanup checkpoint page ${String(pageNumber)}: ${getErrorMessage(error)}`,
                            );
                        }
                    }
                    if (manifestDirty) {
                        current.updatedAtMs = Date.now();
                        await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn).catch(() => undefined);
                    }
                    return restored;
                },
                lockOptions,
            );
        },
        commitCompletedPages(pages, planSignature, scopeKey, documentInkPrior) {
            if (pages.length === 0 && (documentInkPrior === undefined || documentInkPrior === null)) {
                return Promise.resolve();
            }
            return withCheckpointDirLock(
                rootRealPath,
                async () => {
                    const stagedRecords = new Map<string, IScanCleanupCheckpointedPageRecord>();
                    const pageDirByKey = new Map<string, string>();
                    const newlyWrittenPaths: string[] = [];
                    const generation = randomBytes(6).toString('hex');
                    try {
                        for (const page of pages) {
                            const pageRealDir = await assertContainedRealDirectory(
                                rootRealPath,
                                [expectedEntryName, ...pageRelativeSegments(page.pageNumber, scopeKey)],
                                true,
                            );
                            const records: IScanCleanupCheckpointArtifactRecord[] = [];
                            for (const artifact of page.artifacts) {
                                if (!isAllowedPageArtifactFileName(page.pageNumber, artifact.fileName)) {
                                    throw new Error(`Unsafe scan cleanup checkpoint artifact name: ${artifact.fileName}`);
                                }
                                // Stage replacement artifacts under unique generation-tagged
                                // filenames so previously committed artifacts stay intact if
                                // staging or manifest publication fails mid-commit.
                                const storedFileName = `${generation}-${artifact.fileName}`;
                                const destinationPath = join(pageRealDir, storedFileName);
                                const existingDest = await lstat(destinationPath).catch(() => null);
                                if (existingDest !== null && existingDest.isSymbolicLink()) {
                                    throw new Error(`Refusing to overwrite symlink in scan cleanup checkpoint: ${destinationPath}`);
                                }
                                const copied = await copyFileAtomicAndDigest(artifact.scratchPath, destinationPath, renameFn);
                                newlyWrittenPaths.push(destinationPath);
                                records.push({
                                    fileName: artifact.fileName,
                                    storedFileName,
                                    sizeBytes: copied.sizeBytes,
                                    sha256: copied.sha256,
                                });
                            }
                            if (records.length > 0) {
                                const key = pageRecordKey(page.pageNumber, scopeKey);
                                pageDirByKey.set(key, pageRealDir);
                                stagedRecords.set(key, {
                                    pageNumber: page.pageNumber,
                                    planSignature,
                                    artifacts: records,
                                });
                            }
                        }

                        // Merge into the latest manifest on disk under lock so concurrent
                        // handles for the same witness never clobber each other's commits.
                        const current = await readCurrentManifestLocked();
                        const supersededPaths: string[] = [];
                        for (const [key, record] of stagedRecords) {
                            const previous = current.completedPages[key];
                            const pageRealDir = pageDirByKey.get(key);
                            if (previous !== undefined && pageRealDir !== undefined) {
                                const nextStoredNames = new Set(
                                    record.artifacts.map((artifact) => artifact.storedFileName ?? artifact.fileName),
                                );
                                for (const oldArtifact of previous.artifacts) {
                                    const oldStoredName = oldArtifact.storedFileName ?? oldArtifact.fileName;
                                    if (!nextStoredNames.has(oldStoredName)) {
                                        supersededPaths.push(join(pageRealDir, oldStoredName));
                                    }
                                }
                            }
                            current.completedPages[key] = record;
                        }
                        if (documentInkPrior !== undefined && documentInkPrior !== null) {
                            current.documentInkPriors[inkPriorScopeKey(scopeKey)] = {
                                planSignature,
                                prior: documentInkPrior,
                            };
                        }
                        current.updatedAtMs = Date.now();
                        await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn);

                        // Only unlink superseded generation artifacts AFTER the new
                        // manifest has been atomically published.
                        await Promise.all(supersededPaths.map((path) => unlink(path).catch(() => undefined)));
                    } catch (error) {
                        await Promise.all(newlyWrittenPaths.map((path) => unlink(path).catch(() => undefined)));
                        throw error;
                    }
                },
                lockOptions,
            );
        },
        restoreCompletedBatch(batchIndex, expectedBatchSignature, expectedPageNumbers, targetBatchPdfPath) {
            return withCheckpointDirLock(
                rootRealPath,
                async () => {
                    const current = await readCurrentManifestLocked();
                    const batchKey = String(batchIndex);
                    const record = current.completedBatches[batchKey];
                    if (record === undefined || record.batchIndex !== batchIndex || record.batchSignature !== expectedBatchSignature) {
                        return null;
                    }
                    const batchRealDir = await tryResolveContainedRealDirectory(rootRealPath, [
                        expectedEntryName,
                        CHECKPOINT_ARTIFACTS_DIRNAME,
                        `batch-${batchKey}`,
                    ]);
                    if (batchRealDir === null) {
                        delete current.completedBatches[batchKey];
                        current.updatedAtMs = Date.now();
                        await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn).catch(() => undefined);
                        return null;
                    }
                    const stateRead = await readRegularFileNoFollow(rootRealPath, batchRealDir, record.stateFileName);
                    if (stateRead === null || stateRead.sizeBytes !== record.stateSizeBytes || stateRead.sha256 !== record.stateSha256) {
                        delete current.completedBatches[batchKey];
                        await safeRemoveContainedDirectoryTree(rootRealPath, batchRealDir).catch(() => undefined);
                        current.updatedAtMs = Date.now();
                        await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn).catch(() => undefined);
                        return null;
                    }
                    let parsedRaw: unknown;
                    try {
                        parsedRaw = JSON.parse(stateRead.bytes.toString('utf8'));
                    } catch {
                        parsedRaw = null;
                    }
                    const validatedState = validateBatchState(
                        parsedRaw,
                        batchIndex,
                        expectedBatchSignature,
                        expectedPageNumbers,
                        record.pdfFileName !== null,
                        record.pdfSizeBytes,
                    );
                    if (validatedState === null) {
                        delete current.completedBatches[batchKey];
                        await safeRemoveContainedDirectoryTree(rootRealPath, batchRealDir).catch(() => undefined);
                        current.updatedAtMs = Date.now();
                        await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn).catch(() => undefined);
                        return null;
                    }
                    if (record.pdfFileName !== null && record.pdfSizeBytes !== null && record.pdfSha256 !== null) {
                        let streamed: 'ok' | 'mismatch';
                        try {
                            streamed = await streamCopyRegularFileNoFollowToTarget(
                                rootRealPath,
                                batchRealDir,
                                record.pdfFileName,
                                targetBatchPdfPath,
                                renameFn,
                                {
                                    expectedSizeBytes: record.pdfSizeBytes,
                                    expectedSha256: record.pdfSha256,
                                },
                            );
                        } catch {
                            await rm(targetBatchPdfPath, {force: true}).catch(() => undefined);
                            return null;
                        }
                        if (streamed !== 'ok') {
                            await rm(targetBatchPdfPath, {force: true}).catch(() => undefined);
                            delete current.completedBatches[batchKey];
                            await safeRemoveContainedDirectoryTree(rootRealPath, batchRealDir).catch(() => undefined);
                            current.updatedAtMs = Date.now();
                            await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn).catch(() => undefined);
                            return null;
                        }
                    }
                    return validatedState;
                },
                lockOptions,
            );
        },
        commitCompletedBatch(batchInput) {
            return withCheckpointDirLock(
                rootRealPath,
                async () => {
                    const batchKey = String(batchInput.batchIndex);
                    const batchRealDir = await assertContainedRealDirectory(
                        rootRealPath,
                        [expectedEntryName, CHECKPOINT_ARTIFACTS_DIRNAME, `batch-${batchKey}`],
                        true,
                    );
                    const generation = randomBytes(6).toString('hex');
                    const newlyWrittenPaths: string[] = [];
                    try {
                        let pdfFileName: string | null = null;
                        let pdfSizeBytes: number | null = null;
                        let pdfSha256: string | null = null;
                        if (batchInput.batchPdfPath !== null) {
                            pdfFileName = `batch-${batchKey}-${generation}.pdf`;
                            const targetPdfPath = join(batchRealDir, pdfFileName);
                            const existingPdf = await lstat(targetPdfPath).catch(() => null);
                            if (existingPdf !== null && existingPdf.isSymbolicLink()) {
                                throw new Error(`Refusing to overwrite symlink in scan cleanup checkpoint: ${targetPdfPath}`);
                            }
                            const copiedPdf = await copyFileAtomicAndDigest(batchInput.batchPdfPath, targetPdfPath, renameFn);
                            newlyWrittenPaths.push(targetPdfPath);
                            pdfSizeBytes = copiedPdf.sizeBytes;
                            pdfSha256 = copiedPdf.sha256;
                        }
                        const state: IScanCleanupCheckpointedBatchState = {
                            batchIndex: batchInput.batchIndex,
                            firstPageNumber: batchInput.firstPageNumber,
                            batchSignature: batchInput.batchSignature,
                            hasBatchPdf: pdfFileName !== null,
                            batchPdfSizeBytes: pdfSizeBytes,
                            summary: batchInput.summary,
                            representationReport: batchInput.representationReport,
                            provenanceStamp: batchInput.provenanceStamp,
                            sourceTextPages: [...batchInput.sourceTextPages],
                            skippedNonAffine: [...batchInput.skippedNonAffine],
                        };
                        const stateFileName = `batch-${batchKey}-${generation}.json`;
                        const stateJson = `${JSON.stringify(state, null, 2)}\n`;
                        const statePath = join(batchRealDir, stateFileName);
                        const existingState = await lstat(statePath).catch(() => null);
                        if (existingState !== null && existingState.isSymbolicLink()) {
                            throw new Error(`Refusing to overwrite symlink in scan cleanup checkpoint: ${statePath}`);
                        }
                        await writeFileAtomic(statePath, stateJson, renameFn);
                        newlyWrittenPaths.push(statePath);
                        const stateStat = await stat(statePath);
                        const stateSha256 = sha256Utf8Hex(stateJson);

                        // Publish the replacement manifest atomically FIRST; only after
                        // manifest rename succeeds may superseded batch generation files
                        // or per-page artifacts be pruned, so an interrupted batch commit
                        // preserves both prior batch checkpoints and page resume.
                        const current = await readCurrentManifestLocked();
                        const previousBatch = current.completedBatches[batchKey];
                        current.completedBatches[batchKey] = {
                            batchIndex: batchInput.batchIndex,
                            batchSignature: batchInput.batchSignature,
                            stateFileName,
                            stateSizeBytes: stateStat.size,
                            stateSha256,
                            pdfFileName,
                            pdfSizeBytes,
                            pdfSha256,
                        };
                        const pageScopePrefix = `batch-${batchKey}-pages:`;
                        for (const key of Object.keys(current.completedPages)) {
                            if (key.startsWith(pageScopePrefix)) {
                                delete current.completedPages[key];
                            }
                        }
                        delete current.documentInkPriors[`batch-${batchKey}-pages`];
                        current.updatedAtMs = Date.now();
                        await writeFileAtomic(manifestPath, `${JSON.stringify(current, null, 2)}\n`, renameFn);

                        if (previousBatch !== undefined) {
                            const supersededBatchFiles: string[] = [];
                            if (previousBatch.stateFileName !== stateFileName) {
                                supersededBatchFiles.push(join(batchRealDir, previousBatch.stateFileName));
                            }
                            if (previousBatch.pdfFileName !== null && previousBatch.pdfFileName !== pdfFileName) {
                                supersededBatchFiles.push(join(batchRealDir, previousBatch.pdfFileName));
                            }
                            await Promise.all(supersededBatchFiles.map((path) => unlink(path).catch(() => undefined)));
                        }

                        const supersededPagesDir = await tryResolveContainedRealDirectory(rootRealPath, [
                            expectedEntryName,
                            CHECKPOINT_ARTIFACTS_DIRNAME,
                            `batch-${batchKey}-pages`,
                        ]);
                        if (supersededPagesDir !== null) {
                            await safeRemoveContainedDirectoryTree(rootRealPath, supersededPagesDir).catch(() => undefined);
                        }
                    } catch (error) {
                        await Promise.all(newlyWrittenPaths.map((path) => unlink(path).catch(() => undefined)));
                        throw error;
                    }
                },
                lockOptions,
            );
        },
        cleanupTempFiles() {
            return withCheckpointDirLock(rootRealPath, () => removeTempFilesInDirectory(rootRealPath, entryRealPath), lockOptions);
        },
        async close() {
            await releaseLease();
        },
        async complete() {
            try {
                await withCheckpointDirLock(
                    rootRealPath,
                    async () => {
                        await releaseLease();
                        if (!(await isEntryActivelyLeased(rootRealPath, entryRealPath))) {
                            await safeRemoveContainedDirectoryTree(rootRealPath, entryRealPath);
                        }
                    },
                    lockOptions,
                );
            } finally {
                await releaseLease();
            }
        },
    };
}
