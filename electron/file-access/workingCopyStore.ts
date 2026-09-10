import {
    resolve,
    win32,
} from 'path';
import {
    realpathSync,
    type BigIntStats,
} from 'fs';
import {spawnSync} from 'node:child_process';
import {
    open,
    stat,
} from 'fs/promises';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';

export type TWorkingCopyRole = 'current' | 'snapshot';
export type TWorkingCopyBackingState =
    | 'cloned'
    | 'eager'
    | 'lazy-original'
    | 'materializing'
    | 'materialized';
export type TWorkingCopyBackingErrorCode =
    | 'SOURCE_BACKING_CHANGED'
    | 'SOURCE_BACKING_UNAVAILABLE'
    | 'WORKING_COPY_MATERIALIZATION_CANCELLED'
    | 'WORKING_COPY_MATERIALIZATION_FAILED'
    | 'WORKING_COPY_MATERIALIZATION_NO_SPACE'
    | 'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED'
    | 'WORKING_COPY_REGISTRATION_CHANGED';

export interface IWorkingCopyAdmissionSnapshot {
    mtimeNs: bigint;
    size: bigint;
}

export interface IWorkingCopyOriginalFileExpectation {
    contentFingerprint?: string;
    ctimeNs?: string;
    deviceId?: string;
    inode?: string;
    mtimeMs: number;
    mtimeNs?: string;
    size: number;
}

export interface IWorkingCopyOriginalEntry {
    admissionSnapshot?: IWorkingCopyAdmissionSnapshot;
    backingState: TWorkingCopyBackingState;
    originalPath: string;
    logicalPath: string;
    ownerWebContentsId?: number;
    originalFileExpectationAbortController?: AbortController;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    registeredAtMs: number;
    registrationId: number;
    role: TWorkingCopyRole;
    sourceBackingErrorCode?: TWorkingCopyBackingErrorCode;
}

interface ISetWorkingCopyOriginalPathOptions {
    admissionSnapshot?: IWorkingCopyAdmissionSnapshot;
    backingState?: TWorkingCopyBackingState;
    deferOriginalFileExpectation?: boolean;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    role?: TWorkingCopyRole;
}

interface IRememberRetiredWorkingCopyOriginalOptions {
    admissionSnapshot?: IWorkingCopyAdmissionSnapshot;
    backingState?: TWorkingCopyBackingState;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    role?: TWorkingCopyRole;
    sourceBackingErrorCode?: TWorkingCopyBackingErrorCode;
}

interface IRetiredWorkingCopyOriginalEntry {
    admissionSnapshot?: IWorkingCopyAdmissionSnapshot;
    backingState: TWorkingCopyBackingState;
    expiresAtMs: number;
    originalPath: string;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    ownerWebContentsId?: number;
    registrationId: number;
    role: TWorkingCopyRole;
    sourceBackingErrorCode?: TWorkingCopyBackingErrorCode;
}

interface IWorkingCopyRecoveryClaim {
    generation: number;
    registrationId: number | null;
}
let retiredWorkingCopyPruneTimer: ReturnType<typeof setTimeout> | null = null;
const currentWorkingCopyByOriginalPath = new Map<string, {
    ownerWebContentsId?: number;
    registeredAtMs: number;
    registrationId: number;
    workingPath: string;
}>();
const pendingWorkingCopyTransferAccess = new Map<string, {
    sourceOwner: number;
    targetOwner: number;
}>();
let nextWorkingCopyRegistrationId = 0;
const RETIRED_WORKING_COPY_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RETIRED_WORKING_COPY_TTL_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 10 * 60 * 1000;
    }
    return Math.min(parsed, 60 * 60 * 1000);
})();
const WINDOWS_CONTENT_FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
const WINDOWS_CONTENT_FINGERPRINT_CHUNK_BYTES = 1024 * 1024;
const windowsCaseSensitivityByDirectory = new Map<string, boolean | null>();

interface IWindowsDirectoryLookup {
    caseSensitive: boolean | null;
    realPath: string | null;
    resolvedPath: string | null;
}

function stripWindowsExtendedLengthPrefix(filePath: string) {
    if (filePath.startsWith('\\\\?\\UNC\\')) {
        return `\\\\${filePath.slice(8)}`;
    }
    if (filePath.startsWith('\\\\?\\')) {
        return filePath.slice(4);
    }
    return filePath;
}

async function runWithWorkingCopyRegistrationTransition<T>(
    workingPath: string,
    operation: () => Promise<T> | T,
) {
    const previousTransition = workingCopyRegistrationTransitions.get(workingPath) ?? Promise.resolve();
    let releaseTransition!: () => void;
    const transitionGate = new Promise<void>((resolveTransition) => {
        releaseTransition = resolveTransition;
    });
    const transitionTail = previousTransition.then(() => transitionGate);
    workingCopyRegistrationTransitions.set(workingPath, transitionTail);
    await previousTransition;
    try {
        return await operation();
    } finally {
        releaseTransition();
        if (workingCopyRegistrationTransitions.get(workingPath) === transitionTail) {
            workingCopyRegistrationTransitions.delete(workingPath);
        }
    }
}

function isWindowsPathLike(filePath: string) {
    const normalizedPath = stripWindowsExtendedLengthPrefix(filePath);
    return /^[a-zA-Z]:[\\/]/.test(normalizedPath) || normalizedPath.startsWith('\\\\');
}

function normalizeResolvedWindowsPath(filePath: string) {
    return win32.resolve(stripWindowsExtendedLengthPrefix(filePath));
}

function resolveWindowsDirectoryLookup(directoryPath: string): IWindowsDirectoryLookup {
    let currentPath = normalizeResolvedWindowsPath(directoryPath);
    while (currentPath && currentPath !== win32.dirname(currentPath)) {
        try {
            const realDirectoryPath = normalizeResolvedWindowsPath(realpathSync.native(currentPath));
            if (windowsCaseSensitivityByDirectory.has(realDirectoryPath)) {
                return {
                    caseSensitive: windowsCaseSensitivityByDirectory.get(realDirectoryPath)!,
                    realPath: realDirectoryPath,
                    resolvedPath: currentPath,
                };
            }
            const result = spawnSync(
                'fsutil.exe',
                [
                    'file',
                    'queryCaseSensitiveInfo',
                    realDirectoryPath,
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 1_000,
                },
            );
            const output = `${String(result.stdout)}\n${String(result.stderr)}`;
            const caseSensitive = /case sensitive attribute .* is enabled/iu.test(output)
                ? true
                : /case sensitive attribute .* is disabled/iu.test(output)
                    ? false
                    : null;
            windowsCaseSensitivityByDirectory.set(realDirectoryPath, caseSensitive);
            return {
                caseSensitive,
                realPath: realDirectoryPath,
                resolvedPath: currentPath,
            };
        } catch {
            currentPath = win32.dirname(currentPath);
        }
    }
    return {
        caseSensitive: null,
        realPath: null,
        resolvedPath: null,
    };
}

function normalizeWindowsPathCase(filePath: string, caseSensitive: boolean | null) {
    return caseSensitive === false ? filePath.toLowerCase() : filePath;
}

export function normalizePathForLookup(filePath: string) {
    if (!filePath || filePath.trim().length === 0) {
        return '';
    }

    if (isWindowsPathLike(filePath)) {
        const resolvedWindowsPath = normalizeResolvedWindowsPath(filePath);
        try {
            // Native realpath resolves ordinary Windows case-insensitive aliases while
            // retaining distinct spellings in a case-sensitive directory.
            const realPath = normalizeResolvedWindowsPath(realpathSync.native(resolvedWindowsPath));
            const directory = resolveWindowsDirectoryLookup(win32.dirname(realPath));
            return normalizeWindowsPathCase(realPath, directory.caseSensitive);
        } catch {
            // A lazy working copy is registered before its leaf exists. Resolve the
            // existing parent so its short and long Windows aliases keep one key.
            // Only the ordinary case-insensitive result is folded; an unknown or
            // case-sensitive share keeps its spelling.
            const directory = resolveWindowsDirectoryLookup(win32.dirname(resolvedWindowsPath));
            const missingLeafPath = directory.realPath && directory.resolvedPath
                ? win32.join(
                    directory.realPath,
                    win32.relative(directory.resolvedPath, resolvedWindowsPath),
                )
                : resolvedWindowsPath;
            return normalizeWindowsPathCase(missingLeafPath, directory.caseSensitive);
        }
    }

    const resolvedPath = resolve(filePath);
    const stableResolvedPath = process.platform === 'darwin' && (
        resolvedPath === '/var'
        || resolvedPath.startsWith('/var/')
    )
        ? `/private${resolvedPath}`
        : resolvedPath;

    try {
        return realpathSync.native(stableResolvedPath);
    } catch {
        return stableResolvedPath;
    }
}

class TCanonicalWorkingCopyMap<TValue> extends Map<string, TValue> {
    override delete(key: string) {
        return super.delete(normalizePathForLookup(key));
    }

    override get(key: string) {
        return super.get(normalizePathForLookup(key));
    }

    override has(key: string) {
        return super.has(normalizePathForLookup(key));
    }

    override set(key: string, value: TValue) {
        return super.set(normalizePathForLookup(key), value);
    }
}

export const workingCopyMap = new TCanonicalWorkingCopyMap<IWorkingCopyOriginalEntry>();
const retiredWorkingCopyOriginalMap = new TCanonicalWorkingCopyMap<IRetiredWorkingCopyOriginalEntry>();
const workingCopyRegistrationTransitions = new TCanonicalWorkingCopyMap<Promise<void>>();
const workingCopyRecoveryClaims = new TCanonicalWorkingCopyMap<IWorkingCopyRecoveryClaim>();
let nextWorkingCopyRecoveryClaimGeneration = 0;

async function createOriginalFileExpectation(
    originalPath: string,
    signal?: AbortSignal,
): Promise<IWorkingCopyOriginalFileExpectation | undefined> {
    try {
        signal?.throwIfAborted();
        const originalStat = await stat(originalPath, {bigint: true});
        signal?.throwIfAborted();
        if (!originalStat.isFile()) {
            return undefined;
        }
        const expectation = createOriginalFileExpectationFromStat(originalStat);
        if (
            process.platform !== 'win32'
            || originalStat.size > BigInt(WINDOWS_CONTENT_FINGERPRINT_MAX_BYTES)
        ) {
            return expectation;
        }

        const handle = await open(originalPath, 'r');
        try {
            const before = await handle.stat({bigint: true});
            if (
                !before.isFile()
                || before.size !== originalStat.size
                || before.dev !== originalStat.dev
                || before.ino !== originalStat.ino
            ) {
                return undefined;
            }
            const hash = createOriginalFileContentFingerprintHash(Number(before.size));
            const buffer = Buffer.allocUnsafe(Math.max(
                1,
                Math.min(Number(before.size), WINDOWS_CONTENT_FINGERPRINT_CHUNK_BYTES),
            ));
            let offset = 0;
            while (offset < Number(before.size)) {
                signal?.throwIfAborted();
                const length = Math.min(buffer.byteLength, Number(before.size) - offset);
                let readOffset = 0;
                while (readOffset < length) {
                    const {bytesRead} = await handle.read(
                        buffer,
                        readOffset,
                        length - readOffset,
                        offset + readOffset,
                    );
                    if (bytesRead <= 0) {
                        return undefined;
                    }
                    hash.update(buffer.subarray(readOffset, readOffset + bytesRead));
                    readOffset += bytesRead;
                }
                offset += length;
            }
            const after = await handle.stat({bigint: true});
            signal?.throwIfAborted();
            if (
                !after.isFile()
                || after.size !== before.size
                || after.dev !== before.dev
                || after.ino !== before.ino
                || after.mtimeNs !== before.mtimeNs
                || after.ctimeNs !== before.ctimeNs
            ) {
                return undefined;
            }
            return {
                ...createOriginalFileExpectationFromStat(after),
                contentFingerprint: `sha256-full-v1:${hash.digest('hex')}`,
            };
        } finally {
            await handle.close().catch(() => undefined);
        }
    } catch {
        return undefined;
    }
}

export function createOriginalFileExpectationFromStat(
    originalStat: BigIntStats,
): IWorkingCopyOriginalFileExpectation {
    return {
        ctimeNs: originalStat.ctimeNs.toString(),
        deviceId: originalStat.dev.toString(),
        inode: originalStat.ino.toString(),
        mtimeMs: Number(originalStat.mtimeNs) / 1_000_000,
        mtimeNs: originalStat.mtimeNs.toString(),
        size: Number(originalStat.size),
    };
}

function copyOriginalFileExpectation(
    expectation: IWorkingCopyOriginalFileExpectation | undefined,
): IWorkingCopyOriginalFileExpectation | undefined {
    if (!expectation) {
        return undefined;
    }
    return {
        ...(expectation.contentFingerprint ? {contentFingerprint: expectation.contentFingerprint} : {}),
        ...(expectation.ctimeNs === undefined ? {} : {ctimeNs: expectation.ctimeNs}),
        ...(expectation.deviceId === undefined ? {} : {deviceId: expectation.deviceId}),
        ...(expectation.inode === undefined ? {} : {inode: expectation.inode}),
        mtimeMs: expectation.mtimeMs,
        ...(expectation.mtimeNs === undefined ? {} : {mtimeNs: expectation.mtimeNs}),
        size: expectation.size,
    };
}

function copyAdmissionSnapshot(
    snapshot: IWorkingCopyAdmissionSnapshot | undefined,
): IWorkingCopyAdmissionSnapshot | undefined {
    return snapshot
        ? {
            mtimeNs: snapshot.mtimeNs,
            size: snapshot.size,
        }
        : undefined;
}

export async function captureWorkingCopyAdmissionSnapshot(
    originalPath: string,
): Promise<IWorkingCopyAdmissionSnapshot> {
    const sourceStat = await stat(originalPath, {bigint: true});
    if (!sourceStat.isFile()) {
        throw new Error('Working-copy source is not a regular file');
    }
    return {
        mtimeNs: sourceStat.mtimeNs,
        size: sourceStat.size,
    };
}

export function workingCopyAdmissionSnapshotsMatch(
    left: IWorkingCopyAdmissionSnapshot,
    right: IWorkingCopyAdmissionSnapshot,
) {
    return left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function isSameOwner(left: number | undefined, right: number | undefined) {
    return left === right;
}

function makeCurrentRegistryKey(originalPath: string, ownerWebContentsId?: number) {
    const lookupOriginalPath = normalizePathForLookup(originalPath);
    if (!lookupOriginalPath) {
        return '';
    }
    return `${ownerWebContentsId ?? 'global'}\0${lookupOriginalPath}`;
}

function isNewerWorkingCopyEntry(left: IWorkingCopyOriginalEntry, right: IWorkingCopyOriginalEntry) {
    return (
        left.registeredAtMs > right.registeredAtMs
        || (
            left.registeredAtMs === right.registeredAtMs
            && left.registrationId > right.registrationId
        )
    );
}

function refreshCurrentWorkingCopyForOriginal(originalPath: string, ownerWebContentsId?: number) {
    const registryKey = makeCurrentRegistryKey(originalPath, ownerWebContentsId);
    if (!registryKey) {
        return;
    }
    const lookupOriginalPath = normalizePathForLookup(originalPath);
    let latestMatch: {
        entry: IWorkingCopyOriginalEntry;
        workingPath: string;
    } | null = null;
    for (const entry of workingCopyMap.values()) {
        if (
            entry.role === 'current'
            && isSameOwner(entry.ownerWebContentsId, ownerWebContentsId)
            && normalizePathForLookup(entry.originalPath) === lookupOriginalPath
            && (!latestMatch || isNewerWorkingCopyEntry(entry, latestMatch.entry))
        ) {
            latestMatch = {
                entry,
                workingPath: entry.logicalPath,
            };
        }
    }

    if (!latestMatch) {
        currentWorkingCopyByOriginalPath.delete(registryKey);
        return;
    }

    currentWorkingCopyByOriginalPath.set(registryKey, {
        ...(latestMatch.entry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: latestMatch.entry.ownerWebContentsId}),
        registeredAtMs: latestMatch.entry.registeredAtMs,
        registrationId: latestMatch.entry.registrationId,
        workingPath: latestMatch.workingPath,
    });
}

function setCurrentWorkingCopyForOriginal(workingPath: string, entry: IWorkingCopyOriginalEntry) {
    if (entry.role !== 'current') {
        return;
    }
    const registryKey = makeCurrentRegistryKey(entry.originalPath, entry.ownerWebContentsId);
    if (!registryKey) {
        return;
    }
    currentWorkingCopyByOriginalPath.set(registryKey, {
        ...(entry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: entry.ownerWebContentsId}),
        registeredAtMs: entry.registeredAtMs,
        registrationId: entry.registrationId,
        workingPath,
    });
}

function pruneRetiredWorkingCopyOriginals() {
    const now = Date.now();
    for (const [
        workingPath,
        entry,
    ] of retiredWorkingCopyOriginalMap.entries()) {
        if (entry.expiresAtMs <= now) {
            retiredWorkingCopyOriginalMap.delete(workingPath);
        }
    }
}

function scheduleRetiredWorkingCopyPrune() {
    if (retiredWorkingCopyPruneTimer) {
        clearTimeout(retiredWorkingCopyPruneTimer);
        retiredWorkingCopyPruneTimer = null;
    }
    let nextExpiresAtMs = Number.POSITIVE_INFINITY;
    for (const entry of retiredWorkingCopyOriginalMap.values()) {
        nextExpiresAtMs = Math.min(nextExpiresAtMs, entry.expiresAtMs);
    }
    if (!Number.isFinite(nextExpiresAtMs)) {
        return;
    }
    retiredWorkingCopyPruneTimer = setTimeout(() => {
        retiredWorkingCopyPruneTimer = null;
        pruneRetiredWorkingCopyOriginals();
        scheduleRetiredWorkingCopyPrune();
    }, Math.max(0, nextExpiresAtMs - Date.now()));
    retiredWorkingCopyPruneTimer.unref();
}

export function getWorkingCopyOriginalPath(workingPath: string, senderWebContentsId?: number) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (activeEntry) {
        if (!canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
            return null;
        }
        return {
            originalPath: activeEntry.originalPath,
            ...(activeEntry.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: activeEntry.ownerWebContentsId}),
            retired: false,
        };
    }

    pruneRetiredWorkingCopyOriginals();
    const retired = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retired) {
        return null;
    }
    if (!canUseWorkingCopyEntry(retired, senderWebContentsId)) {
        return null;
    }

    return {
        originalPath: retired.originalPath,
        ...(retired.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: retired.ownerWebContentsId}),
        retired: true,
    };
}

/** Main-process persistence migration only; renderer-facing lookups remain owner-scoped. */
export function getWorkingCopyOriginalPathForPersistence(workingPath: string) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (activeEntry) {
        return {originalPath: activeEntry.originalPath};
    }

    pruneRetiredWorkingCopyOriginals();
    const retiredEntry = retiredWorkingCopyOriginalMap.get(workingPath);
    return retiredEntry ? {originalPath: retiredEntry.originalPath} : null;
}

function isSameWorkingCopyEntry(
    entry: IWorkingCopyOriginalEntry,
    expected: {
        originalPath: string;
        ownerWebContentsId?: number;
        registrationId: number;
    },
) {
    return (
        entry.registrationId === expected.registrationId
        && entry.originalPath === expected.originalPath
        && isSameOwner(entry.ownerWebContentsId, expected.ownerWebContentsId)
    );
}

export async function setWorkingCopyOriginalPath(
    workingPath: string,
    originalPath: string,
    ownerWebContentsId?: number,
    options: ISetWorkingCopyOriginalPathOptions = {},
) {
    let entry!: IWorkingCopyOriginalEntry;
    await runWithWorkingCopyRegistrationTransition(workingPath, () => {
        const existingEntry = workingCopyMap.get(workingPath);
        if (existingEntry) {
            existingEntry.originalFileExpectationAbortController?.abort();
            workingCopyMap.delete(workingPath);
            refreshCurrentWorkingCopyForOriginal(existingEntry.originalPath, existingEntry.ownerWebContentsId);
        }

        const role = options.role ?? 'current';
        const admissionSnapshot = copyAdmissionSnapshot(options.admissionSnapshot);
        const originalFileExpectation = copyOriginalFileExpectation(options.originalFileExpectation);
        entry = {
            ...(admissionSnapshot ? {admissionSnapshot} : {}),
            backingState: options.backingState ?? 'eager',
            originalPath,
            logicalPath: workingPath,
            ...(typeof ownerWebContentsId === 'number' ? {ownerWebContentsId} : {}),
            ...(originalFileExpectation ? {originalFileExpectation} : {}),
            registeredAtMs: Date.now(),
            registrationId: nextWorkingCopyRegistrationId += 1,
            role,
        };
        workingCopyMap.set(workingPath, entry);
        retiredWorkingCopyOriginalMap.delete(workingPath);
        setCurrentWorkingCopyForOriginal(workingPath, entry);
    });

    // Normal mapped working copies capture a stat witness here. Small Windows
    // sources also get a bounded content fingerprint, while routes that
    // explicitly defer the witness remain fail-closed until they refresh it.
    if (options.deferOriginalFileExpectation || options.originalFileExpectation) {
        return;
    }

    const expectationAbortController = new AbortController();
    entry.originalFileExpectationAbortController = expectationAbortController;
    const expectationPromise = createOriginalFileExpectation(
        originalPath,
        expectationAbortController.signal,
    );
    const originalFileExpectation = await expectationPromise;
    applyOriginalFileExpectation(entry, workingPath, originalFileExpectation);
}

function applyOriginalFileExpectation(
    entry: IWorkingCopyOriginalEntry,
    workingPath: string,
    originalFileExpectation: IWorkingCopyOriginalFileExpectation | undefined,
) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || activeEntry !== entry || !isSameWorkingCopyEntry(activeEntry, entry)) {
        return;
    }
    delete activeEntry.originalFileExpectationAbortController;
    if (originalFileExpectation) {
        activeEntry.originalFileExpectation = originalFileExpectation;
    } else {
        delete activeEntry.originalFileExpectation;
    }
}

export function rememberRetiredWorkingCopyOriginal(
    workingPath: string,
    originalPath: string | undefined,
    ownerWebContentsId?: number,
    options: IRememberRetiredWorkingCopyOriginalOptions = {},
) {
    if (!originalPath) {
        return;
    }
    pruneRetiredWorkingCopyOriginals();
    const activeEntry = workingCopyMap.get(workingPath);
    const admissionSnapshot = copyAdmissionSnapshot(options.admissionSnapshot ?? activeEntry?.admissionSnapshot);
    const originalFileExpectation = copyOriginalFileExpectation(
        options.originalFileExpectation ?? activeEntry?.originalFileExpectation,
    );
    const sourceBackingErrorCode = options.sourceBackingErrorCode ?? activeEntry?.sourceBackingErrorCode;
    retiredWorkingCopyOriginalMap.set(workingPath, {
        ...(admissionSnapshot ? {admissionSnapshot} : {}),
        backingState: options.backingState ?? activeEntry?.backingState ?? 'eager',
        originalPath,
        ...(originalFileExpectation ? {originalFileExpectation} : {}),
        ...(typeof ownerWebContentsId === 'number' ? {ownerWebContentsId} : {}),
        expiresAtMs: Date.now() + RETIRED_WORKING_COPY_TTL_MS,
        registrationId: activeEntry?.registrationId ?? (nextWorkingCopyRegistrationId += 1),
        role: options.role ?? 'current',
        ...(sourceBackingErrorCode ? {sourceBackingErrorCode} : {}),
    });
    scheduleRetiredWorkingCopyPrune();
}

export function clearRetiredWorkingCopyOriginals() {
    retiredWorkingCopyOriginalMap.clear();
    scheduleRetiredWorkingCopyPrune();
}

export function forgetRetiredWorkingCopyOriginal(workingPath: string) {
    retiredWorkingCopyOriginalMap.delete(workingPath);
    scheduleRetiredWorkingCopyPrune();
}

export function getRetiredWorkingCopyOriginalCountForTests() {
    return retiredWorkingCopyOriginalMap.size;
}

export function forgetWorkingCopyOriginalPath(workingPath: string) {
    pendingWorkingCopyTransferAccess.delete(normalizePathForLookup(workingPath) || workingPath);
    const existingEntry = workingCopyMap.get(workingPath);
    if (!existingEntry) {
        return false;
    }

    existingEntry.originalFileExpectationAbortController?.abort();
    workingCopyMap.delete(workingPath);
    refreshCurrentWorkingCopyForOriginal(existingEntry.originalPath, existingEntry.ownerWebContentsId);
    return true;
}

export function clearWorkingCopyOriginalPaths() {
    for (const entry of workingCopyMap.values()) {
        entry.originalFileExpectationAbortController?.abort();
    }
    workingCopyMap.clear();
    currentWorkingCopyByOriginalPath.clear();
    pendingWorkingCopyTransferAccess.clear();
}

function canUseWorkingCopyEntry(entry: {ownerWebContentsId?: number}, senderWebContentsId?: number) {
    return entry.ownerWebContentsId === undefined || entry.ownerWebContentsId === senderWebContentsId;
}

function getCurrentWorkingCopyForRegistryKey(registryKey: string, senderWebContentsId?: number) {
    const currentEntry = currentWorkingCopyByOriginalPath.get(registryKey);
    if (!currentEntry) {
        return null;
    }

    const activeEntry = workingCopyMap.get(currentEntry.workingPath);
    if (
        !activeEntry
        || activeEntry.role !== 'current'
        || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)
        || makeCurrentRegistryKey(activeEntry.originalPath, activeEntry.ownerWebContentsId) !== registryKey
    ) {
        currentWorkingCopyByOriginalPath.delete(registryKey);
        if (activeEntry) {
            refreshCurrentWorkingCopyForOriginal(activeEntry.originalPath, activeEntry.ownerWebContentsId);
        }
        return null;
    }

    return currentEntry.workingPath;
}

export function findWorkingCopyPathByOriginalPath(originalPath: string, senderWebContentsId?: number) {
    if (typeof originalPath !== 'string' || !originalPath.trim()) {
        return null;
    }

    if (typeof senderWebContentsId === 'number') {
        const senderScopedPath = getCurrentWorkingCopyForRegistryKey(
            makeCurrentRegistryKey(originalPath, senderWebContentsId),
            senderWebContentsId,
        );
        if (senderScopedPath) {
            return senderScopedPath;
        }
    }

    return getCurrentWorkingCopyForRegistryKey(
        makeCurrentRegistryKey(originalPath),
        senderWebContentsId,
    );
}

export function isKnownWorkingCopyOriginalPath(originalPath: string, senderWebContentsId?: number) {
    if (typeof originalPath !== 'string' || !originalPath.trim()) {
        return false;
    }
    const lookupOriginalPath = normalizePathForLookup(originalPath);
    return Array.from(workingCopyMap.values())
        .some(entry => (
            canUseWorkingCopyEntry(entry, senderWebContentsId)
            && normalizePathForLookup(entry.originalPath) === lookupOriginalPath
        ));
}

/**
 * Main-process liveness query for resources backing any active working copy.
 *
 * Renderer-facing lookups must remain owner-scoped, but main-owned lifecycle
 * services (for example generated-output pruning) need the union of every
 * WebContents owner so one window cannot retire another window's source.
 */
export function isWorkingCopyOriginalPathRegistered(originalPath: string) {
    if (typeof originalPath !== 'string' || !originalPath.trim()) {
        return false;
    }
    const lookupOriginalPath = normalizePathForLookup(originalPath);
    return Array.from(workingCopyMap.values())
        .some(entry => normalizePathForLookup(entry.originalPath) === lookupOriginalPath);
}

export function getWorkingCopyOwnerWebContentsId(workingPath: string): number | undefined {
    return workingCopyMap.get(workingPath)?.ownerWebContentsId;
}

/**
 * A claimed recovery copy remains protected while the renderer proves that it
 * opened and adopted the bytes. The checkpoint acknowledgement or explicit
 * discard retires the claim. Registration ids make a claim auditable without
 * making a path reusable by a late failed open.
 */
export function claimWorkingCopyRecovery(workingPath: string) {
    const normalizedPath = normalizePathForLookup(workingPath) || workingPath;
    const entry = workingCopyMap.get(normalizedPath) ?? workingCopyMap.get(workingPath);
    const generation = nextWorkingCopyRecoveryClaimGeneration += 1;
    workingCopyRecoveryClaims.set(normalizedPath, {
        generation,
        registrationId: entry?.registrationId ?? null,
    });
    return generation;
}

export function hasWorkingCopyRecoveryClaim(workingPath: string) {
    const normalizedPath = normalizePathForLookup(workingPath) || workingPath;
    return workingCopyRecoveryClaims.has(normalizedPath);
}

export function releaseWorkingCopyRecovery(workingPath: string, generation?: number) {
    const normalizedPath = normalizePathForLookup(workingPath) || workingPath;
    const claim = workingCopyRecoveryClaims.get(normalizedPath);
    if (!claim || (generation !== undefined && claim.generation !== generation)) {
        return false;
    }
    workingCopyRecoveryClaims.delete(normalizedPath);
    return true;
}

export function claimWorkingCopyOwnership(
    workingPath: string,
    expectedOwnerWebContentsId: number,
    nextOwnerWebContentsId: number,
) {
    const entry = workingCopyMap.get(workingPath);
    if (!entry || entry.ownerWebContentsId !== expectedOwnerWebContentsId) {
        return false;
    }
    workingCopyMap.delete(workingPath);
    refreshCurrentWorkingCopyForOriginal(entry.originalPath, entry.ownerWebContentsId);
    entry.ownerWebContentsId = nextOwnerWebContentsId;
    workingCopyMap.set(workingPath, entry);
    setCurrentWorkingCopyForOriginal(workingPath, entry);
    return true;
}

export function grantWorkingCopyTransferAccess(
    workingPath: string,
    sourceOwner: number,
    targetOwner: number,
) {
    const entry = workingCopyMap.get(workingPath);
    if (!entry || entry.ownerWebContentsId !== sourceOwner) {
        return false;
    }
    const key = normalizePathForLookup(workingPath) || workingPath;
    if (pendingWorkingCopyTransferAccess.has(key)) {
        return false;
    }
    pendingWorkingCopyTransferAccess.set(key, {
        sourceOwner,
        targetOwner,
    });
    return true;
}

export function hasWorkingCopyTransferAccess(workingPath: string, senderWebContentsId: number) {
    const key = normalizePathForLookup(workingPath) || workingPath;
    return pendingWorkingCopyTransferAccess.get(key)?.targetOwner === senderWebContentsId;
}

export function commitWorkingCopyTransferAccess(
    workingPath: string,
    sourceOwner: number,
    targetOwner: number,
) {
    const key = normalizePathForLookup(workingPath) || workingPath;
    const pending = pendingWorkingCopyTransferAccess.get(key);
    if (!pending || pending.sourceOwner !== sourceOwner || pending.targetOwner !== targetOwner) {
        return false;
    }
    if (!claimWorkingCopyOwnership(workingPath, sourceOwner, targetOwner)) {
        pendingWorkingCopyTransferAccess.delete(key);
        return false;
    }
    pendingWorkingCopyTransferAccess.delete(key);
    return true;
}

export function revokeWorkingCopyTransferAccess(
    workingPath: string,
    sourceOwner: number,
    targetOwner: number,
) {
    const key = normalizePathForLookup(workingPath) || workingPath;
    const pending = pendingWorkingCopyTransferAccess.get(key);
    if (!pending || pending.sourceOwner !== sourceOwner || pending.targetOwner !== targetOwner) {
        return false;
    }
    pendingWorkingCopyTransferAccess.delete(key);
    return true;
}

export function getWorkingCopyRegistrationId(workingPath: string, senderWebContentsId?: number): number | null {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
        return null;
    }

    return activeEntry.registrationId;
}

export function getWorkingCopyBackingEntry(
    workingPath: string,
    senderWebContentsId?: number,
): IWorkingCopyOriginalEntry | null {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
        return null;
    }
    return activeEntry;
}

export function getWorkingCopyBackingMetadata(
    workingPath: string,
    senderWebContentsId?: number,
) {
    const activeEntry = getWorkingCopyBackingEntry(workingPath, senderWebContentsId);
    if (activeEntry) {
        return {
            admissionSnapshot: copyAdmissionSnapshot(activeEntry.admissionSnapshot),
            backingState: activeEntry.backingState,
            registrationId: activeEntry.registrationId,
            retired: false,
            ...(activeEntry.sourceBackingErrorCode
                ? {sourceBackingErrorCode: activeEntry.sourceBackingErrorCode}
                : {}),
        };
    }

    pruneRetiredWorkingCopyOriginals();
    const retiredEntry = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retiredEntry || !canUseWorkingCopyEntry(retiredEntry, senderWebContentsId)) {
        return null;
    }
    return {
        admissionSnapshot: copyAdmissionSnapshot(retiredEntry.admissionSnapshot),
        backingState: retiredEntry.backingState,
        registrationId: retiredEntry.registrationId,
        retired: true,
        ...(retiredEntry.sourceBackingErrorCode
            ? {sourceBackingErrorCode: retiredEntry.sourceBackingErrorCode}
            : {}),
    };
}

export function transitionWorkingCopyBackingState(
    workingPath: string,
    registrationId: number,
    backingState: TWorkingCopyBackingState,
    options: {
        expectedBackingState?: TWorkingCopyBackingState | TWorkingCopyBackingState[];
        originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
        sourceBackingErrorCode?: TWorkingCopyBackingErrorCode | null;
    } = {},
) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || activeEntry.registrationId !== registrationId) {
        return false;
    }
    const expectedBackingStates = Array.isArray(options.expectedBackingState)
        ? options.expectedBackingState
        : options.expectedBackingState
            ? [options.expectedBackingState]
            : null;
    if (expectedBackingStates && !expectedBackingStates.includes(activeEntry.backingState)) {
        return false;
    }
    activeEntry.backingState = backingState;
    if (options.originalFileExpectation) {
        const originalFileExpectation = copyOriginalFileExpectation(options.originalFileExpectation);
        if (originalFileExpectation) {
            activeEntry.originalFileExpectation = originalFileExpectation;
        }
    }
    if (options.sourceBackingErrorCode === null) {
        delete activeEntry.sourceBackingErrorCode;
    } else if (options.sourceBackingErrorCode) {
        activeEntry.sourceBackingErrorCode = options.sourceBackingErrorCode;
    }
    return true;
}

export async function runWithWorkingCopyRegistrationFence<T>(
    workingPath: string,
    registrationId: number,
    operation: (entry: IWorkingCopyOriginalEntry) => Promise<T> | T,
) {
    return runWithWorkingCopyRegistrationTransition(workingPath, async () => {
        const activeEntry = workingCopyMap.get(workingPath);
        if (!activeEntry || activeEntry.registrationId !== registrationId) {
            return {matched: false as const};
        }
        return {
            matched: true as const,
            value: await operation(activeEntry),
        };
    });
}

export function getWorkingCopyRole(workingPath: string, senderWebContentsId?: number): TWorkingCopyRole | null {
    const activeEntry = workingCopyMap.get(workingPath);
    if (activeEntry) {
        return canUseWorkingCopyEntry(activeEntry, senderWebContentsId) ? activeEntry.role : null;
    }

    pruneRetiredWorkingCopyOriginals();
    const retiredEntry = retiredWorkingCopyOriginalMap.get(workingPath);
    if (!retiredEntry || !canUseWorkingCopyEntry(retiredEntry, senderWebContentsId)) {
        return null;
    }

    return retiredEntry.role;
}

export function getWorkingCopyOriginalFileExpectation(
    workingPath: string,
    senderWebContentsId?: number,
): IWorkingCopyOriginalFileExpectation | null {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
        return null;
    }

    return copyOriginalFileExpectation(activeEntry.originalFileExpectation) ?? null;
}

export async function refreshWorkingCopyOriginalFileExpectation(
    workingPath: string,
    senderWebContentsId?: number,
) {
    const activeEntry = workingCopyMap.get(workingPath);
    if (!activeEntry || !canUseWorkingCopyEntry(activeEntry, senderWebContentsId)) {
        return false;
    }

    const expectation = await createOriginalFileExpectation(activeEntry.originalPath);
    const currentEntry = workingCopyMap.get(workingPath);
    if (
        !currentEntry
        || currentEntry !== activeEntry
        || !canUseWorkingCopyEntry(currentEntry, senderWebContentsId)
        || !isSameWorkingCopyEntry(currentEntry, activeEntry)
    ) {
        return false;
    }
    if (expectation) {
        currentEntry.originalFileExpectation = expectation;
    } else {
        delete currentEntry.originalFileExpectation;
    }
    return true;
}
