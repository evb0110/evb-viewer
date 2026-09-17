import {spawn} from 'child_process';
import {constants as fsConstants} from 'fs';
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
} from '@contracts/electronApiScanCleanup';
import type {TWorkerLog} from '@electron/features/ocr/publicNative';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {
    decodeNativeScanCleanupEnvelope,
    parseNativeScanCleanupStderr,
} from '@electron/features/scan-cleanup/native/protocolCodec';
import {verifyNativeToolProtocol} from '@electron/native-tools/runNativeToolCommand';
import {acquireNativeCommandAdmission} from '@electron/native-tools/runNativeCommand';
import {createScanCleanupSidecarProtocolHandler} from '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler';
import type {IScanCleanupSidecarProtocolCapabilities} from '@evb/scan-cleanup/core/types';

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
    const handshake = await verifyNativeToolProtocol(binaryPath, {
        signal,
        log,
    });
    const capabilities: IScanCleanupSidecarProtocolCapabilities = {structuredWarningEventsSupported: handshake?.capabilities?.includes('structured-warning-events') ?? false};
    // The sidecar fans out over Rayon, so it is admitted through the same gate
    // as pdftoppm and qpdf instead of spawning beside them unaccounted.
    const releaseAdmission = await acquireNativeCommandAdmission(signal);
    try {
        await streamScanCleanupSidecar(
            binaryPath,
            manifestPath,
            signal,
            log,
            onProgress,
            options,
        );
        return capabilities;
    } finally {
        releaseAdmission();
    }
}

async function streamScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (nativeProgress: TNativeScanCleanupProgressV3) => void,
    options: IRunScanCleanupSidecarOptions,
) {
    const child = spawn(binaryPath, [
        '--manifest',
        manifestPath,
        ...(options.allowedPathRoot === undefined
            ? []
            : [
                '--allowed-path-root',
                options.allowedPathRoot,
            ]),
    ], createDetachedChildProcessSpawnOptions({stdio: [
        'ignore',
        'pipe',
        'pipe',
    ]}));
    let childClosed = false;
    let runDeferredRecovery: (() => void) | null = null;
    child.once('close', () => {
        childClosed = true;
        runDeferredRecovery?.();
    });
    if (options.priority === 'background' && child.pid !== undefined) {
        try {
            setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
        } catch (error) {
            // Priority is an optimisation, not a correctness boundary. Some
            // sandboxed and hardened runtimes reject it; admission control and
            // cancellation still keep the process bounded there.
            log('debug', `Could not lower scan cleanup detection priority: ${String(error)}`);
        }
    }
    const startedAt = performance.now();
    let terminalResult = null as 'success' | 'failure' | null;
    let protocolError: Error | null = null;
    let nativeFailure: NativeScanCleanupError | null = null;
    let terminationPromise: Promise<boolean> | null = null;
    let settleFatal: (() => void) | null = null;
    // Analyze emits a provisional page-analyzed frame and then a terminal
    // page-complete frame for the same page. Keep only the terminal timing
    // payload, with last-write-wins for any repeated terminal frame, so the
    // diagnostic totals represent each page once and use reconciled timings.
    const terminalPageTimings = new Map<number, TNativeScanCleanupPageStageTimingsV3>();
    let terminalUnkeyedTimings = null as TNativeScanCleanupPageStageTimingsV3 | null;
    // The fallback timer bounds how long this adapter waits, not whether the
    // tree died. It resolves `false`, which every caller below turns into an
    // error the working-copy owner can see, so a bound that expires quarantines
    // the source bytes instead of authorising their deletion.
    const terminateForFatalError = () => {
        void ensureDeferredRecovery();
        if (terminationPromise !== null) {
            return terminationPromise;
        }
        const treeTermination = terminateDetachedChildProcess(
            child,
            SCAN_CLEANUP_TERMINATION_GRACE_MS,
        ).catch(() => false);
        terminationPromise = new Promise<boolean>(resolve => {
            let settled = false;
            const settle = (terminated: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(fallbackHandle);
                resolve(terminated);
            };
            const fallbackHandle = setTimeout(() => settle(false), SCAN_CLEANUP_TERMINATION_FALLBACK_MS);
            fallbackHandle.unref();
            void treeTermination.then(terminated => settle(terminated === true));
        });
        return terminationPromise;
    };
    const describeUnprovenTermination = () => (
        `evb-scan-cleanup process tree (pid=${String(child.pid)}) was not proven dead within `
        + `${SCAN_CLEANUP_TERMINATION_FALLBACK_MS}ms of termination; its inputs may still be open`
    );
    const withTerminationProof = <T>(error: T, terminated: boolean) => (
        terminated ? error : markUnprovenNativeTermination(error, describeUnprovenTermination())
    );
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
                    log('warn', `Deferred scan-cleanup recovery owner failed: ${String(error)}`);
                });
            }
        }
        runDeferredRecovery?.();
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
                    log('warn', `Recovered staged scan-cleanup destinations from ${basename(manifestPath)}`);
                }
                return true;
            } catch (error) {
                log('warn', `Could not recover staged scan-cleanup destinations: ${String(error)}`);
                return false;
            }
        })();
        const recovered = await publicationReplayPromise;
        settleDeferredRecovery(recovered);
        return recovered;
    };
    runDeferredRecovery = () => {
        if (deferredRecoveryPromise === null || !childClosed) return;
        void replayPublicationJournal(true);
    };
    if (childClosed) runDeferredRecovery();
    const fatalSettlement = new Promise<never>((_resolve, reject) => {
        settleFatal = () => {
            void terminateForFatalError().then(async (terminated) => {
                if (!terminated) {
                    log('warn', describeUnprovenTermination());
                }
                await replayPublicationJournal(terminated);
                if (protocolError !== null) {
                    reject(withTerminationProof(protocolError, terminated));
                    return;
                }
                reject(withTerminationProof(abortErrorFromSignal(signal), terminated));
            });
        };
    });
    const protocol = createScanCleanupSidecarProtocolHandler({
        stdout: child.stdout,
        stderr: child.stderr,
        onProtocolError: error => {
            protocolError = error;
            // A fatal decoder/schema/progress-consumer failure means stdout can no
            // longer be consumed safely. Stop the whole detached tree immediately;
            // the recorded protocol error remains the terminal authority.
            settleFatal?.();
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
                // The decoded frame travels unchanged. Detection, raster
                // conversion, lossless conversion, and preview each map it onto
                // the stage and percentage their own run presents; a second
                // stage model here labelled analyze completion `rendering` for
                // consumers that never asked for it.
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
    // A protocol failure or a timeout both end with the tree being stopped, and
    // both report whether that stop was proven so the caller inherits the same
    // quarantine decision an abort would have produced.
    const settleTerminalFailure = async () => {
        const terminal = protocolError ?? timeoutError;
        if (terminal === null) {
            return;
        }
        const terminated = await terminateForFatalError();
        if (!terminated) {
            log('warn', describeUnprovenTermination());
        }
        await replayPublicationJournal(terminated);
        throw withTerminationProof(terminal, terminated);
    };
    let aborting = false as boolean;
    const handleAbort = () => {
        aborting = true;
        // AbortSignal is the transport boundary. This native adapter first asks
        // the detached process tree to exit, then force-kills after its grace period.
        settleFatal?.();
    };
    signal.addEventListener('abort', handleAbort, {once: true});
    if (signal.aborted) handleAbort();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: NativeScanCleanupError | null = null;
    try {
        let result: {
            code: number | null;
            signal: NodeJS.Signals | null
        };
        try {
            result = await Promise.race([
                new Promise<{
                    code: number | null;
                    signal: NodeJS.Signals | null;
                }>((resolve, reject) => {
                    child.once('error', reject);
                    // `exit` can precede the final stdout read. `close` is the
                    // observation boundary because it follows stdio shutdown.
                    child.once('close', (code, exitSignal) => resolve({
                        code,
                        signal: exitSignal,
                    }));
                }),
                new Promise<never>((_resolve, reject) => {
                    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_SCAN_CLEANUP_SIDECAR_TIMEOUT_MS);
                    timeoutHandle = setTimeout(() => {
                        timeoutError = new NativeScanCleanupError(
                            'native-failure',
                            `evb-scan-cleanup timed out after ${timeoutMs}ms`,
                        );
                        void terminateForFatalError().then(terminated => (
                            reject(withTerminationProof(timeoutError, terminated))
                        ));
                    }, timeoutMs);
                    timeoutHandle.unref();
                }),
                fatalSettlement,
            ]);
        } catch (error) {
            await settleTerminalFailure();
            throw error;
        }
        await settleTerminalFailure();
        if (aborting || signal.aborted) {
            // A signal that arrives while the child is still being observed goes
            // through the same termination proof as every other stop path.
            const terminated = await terminateForFatalError();
            if (!terminated) {
                log('warn', describeUnprovenTermination());
            }
            await replayPublicationJournal(terminated);
            throw withTerminationProof(abortErrorFromSignal(signal), terminated);
        }
        if (nativeFailure !== null) await replayPublicationJournal();
        throwIfError(nativeFailure);
        if (result.code !== 0) {
            await replayPublicationJournal();
            const envelope = parseNativeScanCleanupStderr(protocol.stderr);
            if (envelope) throw new NativeScanCleanupError(envelope.code, envelope.message);
            throw new NativeScanCleanupError(
                'native-failure',
                `evb-scan-cleanup exited unsuccessfully (code=${String(result.code)}, signal=${String(result.signal)})`,
            );
        }
        if (terminalResult !== 'success') {
            await replayPublicationJournal();
            throw new NativeScanCleanupError('native-failure', 'evb-scan-cleanup returned no terminal result envelope');
        }
    } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', handleAbort);
        protocol.lines.close();
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
            `evb-scan-cleanup timings ${basename(manifestPath)}:`,
            `wall=${formatSeconds(performance.now() - startedAt)}`,
            `timedPages=${terminalPageTimings.size + Number(terminalUnkeyedTimings !== null)}`,
            ...describeStageTotals(stageTotalsMs),
        ].join(' '));
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
