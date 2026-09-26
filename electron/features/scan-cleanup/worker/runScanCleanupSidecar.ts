import {constants as fsConstants} from 'fs';
import {PassThrough} from 'node:stream';
import {
    access,
    lstat,
    readFile,
    rename,
    stat,
    unlink,
} from 'fs/promises';
import {
    basename, resolve,
} from 'path';
import {
    constants as osConstants,
    setPriority,
} from 'os';
import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    TNativeScanCleanupPageStageTimingsV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {TWorkerLog} from '@electron/features/ocr/publicNative';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {
    decodeNativeScanCleanupEnvelope,
    parseNativeScanCleanupStderr,
} from '@electron/features/scan-cleanup/native/protocolCodec';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {createScanCleanupSidecarProtocolHandler} from '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler';

export class NativeScanCleanupError extends Error {
    constructor(readonly code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'NativeScanCleanupError';
    }
}

interface IRunScanCleanupSidecarOptions {
    priority?: 'background';
    timeoutMs?: number;
    /**
     * Directory the native binary must keep every manifest path inside. The
     * root travels in argv rather than in the manifest so a manifest can never
     * widen the boundary it is checked against.
     */
    allowedPathRoot?: string;
    /**
     * Receives a promise that settles after deferred publication recovery
     * completes. The manifest owner retains its scratch until it succeeds.
     */
    onRecoveryPending?: (recovery: Promise<boolean>) => void | Promise<void>;
}

const DEFAULT_SCAN_CLEANUP_SIDECAR_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const SCAN_CLEANUP_TERMINATION_GRACE_MS = 1_500;
const SCAN_CLEANUP_TERMINATION_FALLBACK_MS = SCAN_CLEANUP_TERMINATION_GRACE_MS + 2_000;
const SCAN_CLEANUP_PUBLICATION_JOURNAL_SUFFIX = '.evb-publication-journal.json';

interface IScanCleanupPublicationJournalEntry {
    original: string;
    backup: string | null;
    remove: boolean;
}

interface IScanCleanupPublicationJournal {
    version: number;
    manifestPath: string;
    committed: boolean;
    entries: IScanCleanupPublicationJournalEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parsePublicationJournal(value: unknown): IScanCleanupPublicationJournal {
    if (!isRecord(value)
        || value.version !== 1
        || typeof value.manifestPath !== 'string'
        || (value.committed !== undefined && typeof value.committed !== 'boolean')
        || !Array.isArray(value.entries)) {
        throw new Error('scan-cleanup publication recovery journal has an invalid shape');
    }
    const entries: IScanCleanupPublicationJournalEntry[] = [];
    for (const entry of value.entries) {
        if (!isRecord(entry)
            || typeof entry.original !== 'string'
            || (entry.remove !== undefined && typeof entry.remove !== 'boolean')) {
            throw new Error('scan-cleanup publication recovery journal contains an invalid entry');
        }
        const remove = entry.remove === true;
        if (remove
            ? entry.backup !== undefined && entry.backup !== null
            : typeof entry.backup !== 'string') {
            throw new Error('scan-cleanup publication recovery journal contains an invalid entry');
        }
        entries.push({
            original: entry.original,
            backup: typeof entry.backup === 'string' ? entry.backup : null,
            remove,
        });
    }
    return {
        version: value.version,
        manifestPath: value.manifestPath,
        committed: value.committed === true,
        entries,
    };
}

/**
 * Replays native publication backups after a sidecar exits before its own
 * transaction can restore or discard them. The journal is named by the exact
 * manifest path, and its embedded path prevents a copied journal from being
 * applied to another run.
 */
export async function replayScanCleanupPublicationJournal(manifestPath: string) {
    const journalPath = `${manifestPath}${SCAN_CLEANUP_PUBLICATION_JOURNAL_SUFFIX}`;
    let contents: string;
    try {
        contents = await readFile(journalPath, 'utf8');
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
    const journal = parsePublicationJournal(JSON.parse(contents) as unknown);
    if (resolve(journal.manifestPath) !== resolve(manifestPath)) {
        throw new Error('scan-cleanup publication recovery journal belongs to another manifest');
    }
    if (journal.committed) {
        for (const entry of journal.entries) {
            if (entry.backup === null) continue;
            let backupStats;
            try {
                backupStats = await lstat(entry.backup);
            } catch (error) {
                if (isNotFound(error)) continue;
                throw error;
            }
            if (!backupStats.isFile()) {
                throw new Error(`publication backup is not a regular file: ${entry.backup}`);
            }
            await unlink(entry.backup);
        }
        await unlink(journalPath);
        return true;
    }
    for (const entry of [...journal.entries].reverse()) {
        if (entry.remove) {
            try {
                const originalStats = await lstat(entry.original);
                if (originalStats.isDirectory()) {
                    throw new Error(`cannot remove ${entry.original}, it is a directory`);
                }
                await unlink(entry.original);
            } catch (error) {
                if (!isNotFound(error)) throw error;
            }
            continue;
        }
        const backup = entry.backup;
        if (backup === null) {
            throw new Error(`publication recovery entry has no backup: ${entry.original}`);
        }
        let backupStats;
        try {
            backupStats = await lstat(backup);
        } catch (error) {
            if (!isNotFound(error)) throw error;
            try {
                const originalStats = await lstat(entry.original);
                if (originalStats.isDirectory()) {
                    throw new Error(`cannot restore ${entry.original} over a directory`);
                }
                continue;
            } catch (originalError) {
                if (isNotFound(originalError)) {
                    throw new Error(`publication backup is missing: ${backup}`);
                }
                throw originalError;
            }
        }
        if (!backupStats.isFile()) {
            throw new Error(`publication backup is not a regular file: ${backup}`);
        }
        try {
            const originalStats = await lstat(entry.original);
            if (originalStats.isDirectory()) {
                throw new Error(`cannot restore ${entry.original} over a directory`);
            }
            await unlink(entry.original);
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        await rename(backup, entry.original);
    }
    await unlink(journalPath);
    return true;
}

function throwIfError(error: Error | null) {
    if (error !== null) {
        throw error;
    }
}

/**
 * Deliberate presentation subset of the native page stage timings. The sidecar
 * summary reports the eight stages a user can act on; the remaining native
 * stages stay diagnostic and must not be added here just because they exist.
 */
type TScanCleanupStageTotalsMs = Record<
    'decode' | 'analysisLevel' | 'normalization' | 'split' | 'deskew' | 'content' | 'render' | 'write',
    number
>;

function addStageTimings(totals: TScanCleanupStageTotalsMs, timings: TNativeScanCleanupPageStageTimingsV3) {
    totals.decode += timings.decodeMs ?? 0;
    totals.analysisLevel += timings.analysisLevelMs ?? 0;
    totals.normalization += timings.normalizationMs ?? 0;
    totals.split += timings.splitMs ?? 0;
    totals.deskew += timings.deskewMs ?? 0;
    totals.content += timings.contentMs ?? 0;
    totals.render += timings.renderMs ?? 0;
    totals.write += timings.writeMs ?? 0;
}

function formatSeconds(milliseconds: number) {
    return `${(milliseconds / 1_000).toFixed(3)}s`;
}

function describeStageTotals(totals: TScanCleanupStageTotalsMs) {
    return Object.entries(totals)
        .filter(([
            ,
            milliseconds,
        ]) => milliseconds > 0)
        .map(([
            stage,
            milliseconds,
        ]) => `${stage}=${formatSeconds(milliseconds)}`);
}

export async function runScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (nativeProgress: TNativeScanCleanupProgressV3) => void,
    options: IRunScanCleanupSidecarOptions = {},
) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
    await streamScanCleanupSidecar(
        binaryPath,
        manifestPath,
        signal,
        log,
        onProgress,
        options,
    );
}

async function streamScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (nativeProgress: TNativeScanCleanupProgressV3) => void,
    options: IRunScanCleanupSidecarOptions,
) {
    const args = [
        '--manifest',
        manifestPath,
        ...(options.allowedPathRoot === undefined
            ? []
            : [
                '--allowed-path-root',
                options.allowedPathRoot,
            ]),
    ];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const startedAt = performance.now();
    let childClosed = false;
    let childPid: number | null = null;
    let terminationConfirmed = false;
    let terminationAttempted = false;
    let stderrTail = '';
    let terminalResult = null as 'success' | 'failure' | null;
    let protocolError: Error | null = null;
    let nativeFailure: NativeScanCleanupError | null = null;
    let aborting = false;
    const processAbort = new AbortController();
    const terminalPageTimings = new Map<number, TNativeScanCleanupPageStageTimingsV3>();
    let terminalUnkeyedTimings = null as TNativeScanCleanupPageStageTimingsV3 | null;
    let publicationReplayPromise: Promise<boolean> | null = null;
    let deferredRecoveryPromise: Promise<boolean> | null = null;
    let resolveDeferredRecovery: ((recovered: boolean) => void) | null = null;
    let deferredRecoverySettled = false;

    const settleDeferredRecovery = (recovered: boolean) => {
        if (deferredRecoverySettled) return;
        deferredRecoverySettled = true;
        resolveDeferredRecovery?.(recovered);
    };
    const ensureDeferredRecovery = () => {
        if (deferredRecoveryPromise === null) {
            deferredRecoveryPromise = new Promise<boolean>(resolve => {
                resolveDeferredRecovery = resolve;
            });
            const recoveryCallback = options.onRecoveryPending?.(deferredRecoveryPromise);
            if (recoveryCallback !== undefined) {
                void recoveryCallback.catch(error => {
                    log('warn', 'Deferred scan-cleanup recovery owner failed: ' + String(error));
                });
            }
        }
        return deferredRecoveryPromise;
    };
    const replayPublicationJournal = async (terminationConfirmed = false): Promise<boolean> => {
        if (!terminationConfirmed && !childClosed) {
            log('warn', 'Retaining scan-cleanup publication journal until the sidecar close is observed');
            return false;
        }
        publicationReplayPromise ??= (async () => {
            try {
                if (await replayScanCleanupPublicationJournal(manifestPath)) {
                    log('warn', 'Recovered staged scan-cleanup destinations from ' + basename(manifestPath));
                }
                return true;
            } catch (error) {
                log('warn', 'Could not recover staged scan-cleanup destinations: ' + String(error));
                return false;
            }
        })();
        const recovered = await publicationReplayPromise;
        settleDeferredRecovery(recovered);
        return recovered;
    };
    const describeUnprovenTermination = () => (
        'evb-scan-cleanup process tree (pid=' + String(childPid) + ') was not proven dead within '
        + String(SCAN_CLEANUP_TERMINATION_FALLBACK_MS) + 'ms of termination; its inputs may still be open'
    );
    const withTerminationProof = (error: Error, terminated: boolean) => (
        terminated ? error : markUnprovenNativeTermination(error, describeUnprovenTermination())
    );
    const protocol = createScanCleanupSidecarProtocolHandler({
        stdout,
        stderr,
        onProtocolError: error => {
            protocolError = error;
            void ensureDeferredRecovery();
            processAbort.abort();
        },
        log,
    });
    protocol.lines.on('line', line => {
        if (protocolError || terminalResult) {
            return;
        }
        try {
            const envelope = decodeNativeScanCleanupEnvelope(line);
            if (envelope.type === 'progress') {
                const nativeProgress = envelope.progress;
                if (nativeProgress.stage === 'page-complete' && nativeProgress.stageTimings !== undefined) {
                    if (nativeProgress.pageNumber === undefined) {
                        terminalUnkeyedTimings = nativeProgress.stageTimings;
                    } else {
                        terminalPageTimings.set(nativeProgress.pageNumber, nativeProgress.stageTimings);
                    }
                }
                onProgress(nativeProgress);
                return;
            }
            terminalResult = envelope.result.status;
            if (envelope.result.status === 'failure') {
                nativeFailure = new NativeScanCleanupError(envelope.result.code, envelope.result.message);
            }
        } catch (error) {
            protocol.failProtocol(error, line);
        }
    });
    const handleAbort = () => {
        aborting = true;
        void ensureDeferredRecovery();
        processAbort.abort();
    };
    signal.addEventListener('abort', handleAbort, {once: true});
    if (signal.aborted) handleAbort();

    try {
        await runNativeToolCommand(binaryPath, args, {
            signal: processAbort.signal,
            timeoutMs: Math.max(1, options.timeoutMs ?? DEFAULT_SCAN_CLEANUP_SIDECAR_TIMEOUT_MS),
            maxStderrBytes: 64 * 1024,
            longLived: true,
            commandLabel: 'evb-scan-cleanup',
            terminationGraceMs: SCAN_CLEANUP_TERMINATION_GRACE_MS,
            onSpawn: pid => {
                childPid = pid;
                if (options.priority === 'background') {
                    try {
                        setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
                    } catch (error) {
                        log('debug', 'Could not lower scan cleanup detection priority: ' + String(error));
                    }
                }
            },
            onStdout: chunk => {
                stdout.write(chunk);
            },
            onStderr: chunk => {
                stderr.write(chunk);
                stderrTail = (stderrTail + chunk).slice(-64 * 1024);
            },
            onClose: () => {
                childClosed = true;
                stdout.end();
                stderr.end();
                if (deferredRecoveryPromise !== null) {
                    void replayPublicationJournal(true);
                }
            },
            onTerminationProof: proof => {
                terminationAttempted = true;
                void proof.then(terminated => {
                    terminationConfirmed = terminated;
                    if (terminated) {
                        void replayPublicationJournal(true);
                    }
                });
            },
            log,
        });
    } catch (cause) {
        const terminated = terminationConfirmed || (!terminationAttempted && childClosed);
        if (protocolError !== null) {
            if (!terminated) log('warn', describeUnprovenTermination());
            await replayPublicationJournal(terminated);
            throw withTerminationProof(protocolError, terminated);
        }
        if (aborting || signal.aborted) {
            if (!terminated) log('warn', describeUnprovenTermination());
            await replayPublicationJournal(terminated);
            throw withTerminationProof(abortErrorFromSignal(signal), terminated);
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (error.message.includes('timed out')) {
            const timeout = new NativeScanCleanupError(
                'native-failure',
                'evb-scan-cleanup timed out after '
                    + String(Math.max(1, options.timeoutMs ?? DEFAULT_SCAN_CLEANUP_SIDECAR_TIMEOUT_MS))
                    + 'ms',
            );
            if (!terminated) log('warn', describeUnprovenTermination());
            await replayPublicationJournal(terminated);
            throw withTerminationProof(timeout, terminated);
        }
        if (!terminationAttempted && childClosed && nativeFailure !== null) {
            await replayPublicationJournal(true);
            throwIfError(nativeFailure);
        }
        await replayPublicationJournal(terminated);
        const envelope = parseNativeScanCleanupStderr(stderrTail);
        if (envelope) {
            throw withTerminationProof(new NativeScanCleanupError(envelope.code, envelope.message), terminated);
        }
        const exitCode = (error as {exitCode?: number | null}).exitCode;
        const exitSignal = (error as {closeSignal?: NodeJS.Signals | null}).closeSignal;
        if (exitCode !== undefined) {
            throw new NativeScanCleanupError(
                'native-failure',
                'evb-scan-cleanup exited unsuccessfully (code=' + String(exitCode)
                    + ', signal=' + String(exitSignal ?? null) + ')',
            );
        }
        throw error;
    } finally {
        signal.removeEventListener('abort', handleAbort);
        stdout.end();
        stderr.end();
        protocol.lines.close();
        if (childClosed || terminationConfirmed) {
            await replayPublicationJournal(true);
        } else if (deferredRecoveryPromise !== null) {
            log('warn', 'Retaining scan-cleanup publication journal until the sidecar stops');
        }
        const stageTotalsMs: TScanCleanupStageTotalsMs = {
            decode: 0,
            analysisLevel: 0,
            normalization: 0,
            split: 0,
            deskew: 0,
            content: 0,
            render: 0,
            write: 0,
        };
        for (const timings of terminalPageTimings.values()) {
            addStageTimings(stageTotalsMs, timings);
        }
        if (terminalUnkeyedTimings !== null) {
            addStageTimings(stageTotalsMs, terminalUnkeyedTimings);
        }
        log('debug', [
            'evb-scan-cleanup timings ' + basename(manifestPath) + ':',
            'wall=' + formatSeconds(performance.now() - startedAt),
            'timedPages=' + String(terminalPageTimings.size + Number(terminalUnkeyedTimings !== null)),
            ...describeStageTotals(stageTotalsMs),
        ].join(' '));
    }

    if (nativeFailure !== null) await replayPublicationJournal();
    throwIfError(nativeFailure);
    if (terminalResult !== 'success') {
        await replayPublicationJournal();
        throw new NativeScanCleanupError('native-failure', 'evb-scan-cleanup returned no terminal result envelope');
    }
}

// The sidecar publishes exactly one raster per output and records which one in
// its metadata, so a declared payload that is missing here is a broken run
// rather than a case to degrade around.
export async function requirePublishedRaster(path: string | undefined, pageNumber: number, role: string) {
    if (path === undefined) {
        throw new Error(`Page ${pageNumber} declared a ${role} without an output destination`);
    }
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Page ${pageNumber} ${role} is unavailable: ${error.message}`);
    });
    if (!stats.isFile()) {
        throw new Error(`Page ${pageNumber} ${role} is not a file: ${path}`);
    }
    await access(path, fsConstants.R_OK).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Page ${pageNumber} ${role} is unreadable: ${error.message}`);
    });
    return path;
}
