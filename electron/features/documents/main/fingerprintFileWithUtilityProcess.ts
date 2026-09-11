import {stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {utilityProcess} from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {
    decodeDocumentSaveUtilityResult,
    decodeDocumentSaveUtilityShutdownResult,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {DOCUMENT_FINGERPRINT_SERVICE_NAME} from '@electron/processDeathRecovery';
import {terminateProcessTree} from '@electron/utils/processTree';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import type {IJobBrokerLease} from '@electron/resources/jobBroker';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMISSION_TIMEOUT_MS = 15_000;
const FINGERPRINT_TIMEOUT_MS = 2 * 60_000;

interface IDocumentSaveUtilityResult {
    bytes: number;
    sha256: string;
}

interface IRetainedDocumentSaveUtility {
    child: ReturnType<typeof utilityProcess.fork>;
    pid?: number;
    releaseResourceLease: () => void;
    retryTermination: () => Promise<boolean>;
}

const retainedDocumentSaveUtilities = new Map<IRetainedDocumentSaveUtility['child'], IRetainedDocumentSaveUtility>();

export function getRetainedDocumentSaveUtilityCount() {
    return retainedDocumentSaveUtilities.size;
}

export async function retryRetainedDocumentSaveUtilityProcesses() {
    const results = await Promise.all([...retainedDocumentSaveUtilities.values()].map(async retained => {
        const proven = await retained.retryTermination();
        if (proven) {
            retained.releaseResourceLease();
            retainedDocumentSaveUtilities.delete(retained.child);
        }
        return proven;
    }));
    return results.every(Boolean);
}

export async function shutdownRetainedDocumentSaveUtilityProcesses() {
    const proven = await retryRetainedDocumentSaveUtilityProcesses();
    if (!proven && retainedDocumentSaveUtilities.size > 0) {
        throw new Error(
            `Document save utility cleanup remains unproven (${retainedDocumentSaveUtilities.size} retained process${retainedDocumentSaveUtilities.size === 1 ? '' : 'es'})`,
        );
    }
}

export async function runDocumentSaveUtilityProcess(options: {
    cwd: string;
    serviceName: string;
    utilityName: string;
    timeoutMs: number;
    request: unknown;
    signal?: AbortSignal;
    resourceLease?: IJobBrokerLease;
}) {
    let resourceLeaseReleased = false;
    const releaseResourceLease = () => {
        if (resourceLeaseReleased) {
            return;
        }
        resourceLeaseReleased = true;
        options.resourceLease?.release();
    };
    if (options.signal?.aborted) {
        releaseResourceLease();
        throw abortErrorFromSignal(options.signal);
    }
    let workerPath: string;
    try {
        workerPath = resolveUnpackedWorkerPath(
            __dirname,
            WORKER_BUNDLES_BY_ID['document-save-utility'].fileName,
        );
    } catch (error) {
        releaseResourceLease();
        throw error;
    }
    return new Promise<IDocumentSaveUtilityResult>((resolve, reject) => {
        let child: ReturnType<typeof utilityProcess.fork>;
        try {
            child = utilityProcess.fork(workerPath, [], {
                cwd: options.cwd,
                serviceName: options.serviceName,
                stdio: 'ignore',
            });
        } catch (error) {
            releaseResourceLease();
            throw error;
        }
        let settled = false;
        let childExited = false;
        let spawned = false;
        let pid: number | undefined;
        let retained: IRetainedDocumentSaveUtility | undefined;
        let shutdownProof: boolean | undefined;
        let shutdownProofPromise: Promise<boolean> | null = null;
        let shutdownProofRequestId: string | null = null;
        let shutdownRequestSequence = 0;
        let resolveShutdownProof: ((requestId: string, proven: boolean) => void) | null = null;
        let resolveSpawnState!: () => void;
        const spawnState = new Promise<void>(resolve => {
            resolveSpawnState = resolve;
        });
        const waitForSpawnState = async () => {
            if (spawned || childExited) {
                return spawned;
            }
            await Promise.race([
                spawnState,
                new Promise<void>(resolve => {
                    const timer = setTimeout(resolve, 2_500);
                    timer.unref();
                }),
            ]);
            return spawned;
        };
        let terminationInFlight: Promise<boolean> | null = null;
        const stopChild = async () => {
            if (terminationInFlight) {
                return terminationInFlight;
            }
            const attempt = (async () => {
                const hasSpawned = await waitForSpawnState();
                if (!hasSpawned) {
                    // A PID exposed by utilityProcess.fork before the spawn event
                    // is not an identity we are allowed to terminate.
                    return childExited;
                }
                if (pid === undefined) {
                    return false;
                }
                if (childExited) {
                    return shutdownProof === true;
                }
                if (shutdownProof !== true && shutdownProofPromise === null) {
                    const requestId = `${pid}:${++shutdownRequestSequence}`;
                    shutdownProofRequestId = requestId;
                    shutdownProof = undefined;
                    shutdownProofPromise = new Promise(resolve => {
                        let settled = false;
                        const settle = (proven: boolean) => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            clearTimeout(timer);
                            resolve(proven);
                        };
                        resolveShutdownProof = (responseRequestId, proven) => {
                            if (responseRequestId !== requestId) {
                                return;
                            }
                            shutdownProof = proven;
                            settle(proven);
                        };
                        const timer = setTimeout(() => {
                            if (shutdownProofRequestId === requestId) {
                                shutdownProof = false;
                                settle(false);
                            }
                        }, 2_500);
                        timer.unref();
                    });
                    try {
                        child.postMessage({
                            type: 'shutdown',
                            requestId,
                        });
                    } catch {
                        shutdownProof = false;
                        resolveShutdownProof?.(requestId, false);
                    }
                }
                const nativeDescendantsTerminated = shutdownProof === true
                    || await shutdownProofPromise!;
                if (!nativeDescendantsTerminated) {
                    shutdownProofPromise = null;
                    resolveShutdownProof = null;
                    shutdownProofRequestId = null;
                }
                let directProcessTerminated = childExited;
                try {
                    if (!childExited) {
                        directProcessTerminated = await terminateProcessTree(pid, {
                            graceMs: 2_500,
                            isTargetAlive: () => child.pid === pid && !childExited,
                            // utilityProcess.fork does not create a detached POSIX process
                            // group. A group probe can therefore miss this live child.
                            preferProcessGroup: false,
                        });
                    }
                } catch {
                    directProcessTerminated = false;
                }
                return directProcessTerminated && nativeDescendantsTerminated && shutdownProof === true;
            })();
            terminationInFlight = attempt;
            void attempt.finally(() => {
                if (terminationInFlight === attempt) {
                    terminationInFlight = null;
                }
            });
            return attempt;
        };
        const retainUntilTerminationProof = () => {
            retained = {
                child,
                pid,
                releaseResourceLease,
                retryTermination: stopChild,
            } satisfies IRetainedDocumentSaveUtility;
            retainedDocumentSaveUtilities.set(child, retained);
        };
        const finish = async (error?: Error, result?: IDocumentSaveUtilityResult) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            const termination = stopChild();
            if (!error && result) {
                retainUntilTerminationProof();
                resolve(result);
                const terminated = await termination;
                if (terminated) {
                    releaseResourceLease();
                    retainedDocumentSaveUtilities.delete(child);
                }
                return;
            }
            const terminated = await termination;
            if (!terminated) {
                retainUntilTerminationProof();
                reject(markUnprovenNativeTermination(
                    error ?? new Error(`${options.utilityName} process did not terminate cleanly.`),
                    `${options.utilityName} process (pid=${child.pid ?? 'unknown'}) was not proven dead`,
                ));
                return;
            }
            releaseResourceLease();
            reject(error);
        };
        const abort = () => {
            void finish(abortErrorFromSignal(options.signal!));
        };
        const timeout = setTimeout(
            () => {
                void finish(new Error(`${options.utilityName} timed out`));
            },
            options.timeoutMs,
        );
        timeout.unref();
        options.signal?.addEventListener('abort', abort, {once: true});
        child.once('spawn', () => {
            spawned = true;
            pid = child.pid;
            if (retained) {
                retained.pid = pid;
            }
            resolveSpawnState();
            if (!settled && !childExited && !options.signal?.aborted) {
                child.postMessage(options.request);
            }
        });
        child.on('message', (value) => {
            const shutdownResult = decodeDocumentSaveUtilityShutdownResult(value);
            if (shutdownResult && shutdownResult.requestId === shutdownProofRequestId) {
                shutdownProof = shutdownResult.terminated;
                resolveShutdownProof?.(shutdownResult.requestId, shutdownResult.terminated);
                return;
            }
            const result = decodeDocumentSaveUtilityResult(value);
            if (!result) {
                void finish(new Error(`${options.utilityName} returned an invalid result`));
                return;
            }
            if (!result.ok) {
                void finish(new Error(result.error));
                return;
            }
            void finish(undefined, {
                bytes: result.bytes,
                sha256: result.sha256,
            });
        });
        child.once('error', (_type, location) => {
            void finish(new Error(`${options.utilityName} failed at ${location}`));
        });
        child.once('exit', code => {
            childExited = true;
            resolveSpawnState();
            if (shutdownProof === undefined) {
                shutdownProof = false;
                if (shutdownProofRequestId) {
                    resolveShutdownProof?.(shutdownProofRequestId, false);
                }
            }
            if (!settled) {
                void finish(new Error(`${options.utilityName} exited before completion (${code})`));
            }
        });
    });
}

export async function fingerprintFileWithUtilityProcess(path: string) {
    const {size} = await stat(path);
    const lease = await mainJobBroker.acquire({
        ownerId: `document-fingerprint:${path}`,
        kind: 'document-save-utility',
        priority: 'foreground',
        admissionClass: 'interactive',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
    });
    let utilityOwnsLease = false;
    try {
        utilityOwnsLease = true;
        return await runDocumentSaveUtilityProcess({
            cwd: dirname(path),
            serviceName: DOCUMENT_FINGERPRINT_SERVICE_NAME,
            utilityName: 'Document fingerprint utility',
            timeoutMs: FINGERPRINT_TIMEOUT_MS,
            request: {
                type: 'inspect',
                sourcePath: path,
                expectedBytes: size,
            },
            resourceLease: lease,
        });
    } finally {
        if (!utilityOwnsLease) {
            lease.release();
        }
    }
}
