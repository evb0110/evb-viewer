import {stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {utilityProcess} from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {decodeDocumentSaveUtilityResult} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {DOCUMENT_FINGERPRINT_SERVICE_NAME} from '@electron/processDeathRecovery';
import {terminateProcessTree} from '@electron/utils/processTree';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import type {IJobBrokerLease} from '@electron/resources/jobBroker';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMISSION_TIMEOUT_MS = 15_000;
const FINGERPRINT_TIMEOUT_MS = 2 * 60_000;

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
    return new Promise<{
        bytes: number;
        sha256: string;
    }>((resolve, reject) => {
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
        const retainResourceLeaseUntilExit = () => {
            if (childExited) {
                releaseResourceLease();
                return;
            }
            child.once('exit', releaseResourceLease);
        };
        const stopChild = async () => {
            const pid = child.pid;
            if (pid === undefined) {
                return true;
            }
            return terminateProcessTree(pid, {
                graceMs: 2_500,
                isTargetAlive: () => child.pid !== undefined,
                // utilityProcess.fork does not create a detached POSIX process
                // group. A group probe can therefore miss this live child.
                preferProcessGroup: false,
            });
        };
        const finish = async (error?: Error, result?: {
            bytes: number;
            sha256: string;
        }) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            const terminated = await stopChild();
            if (!terminated) {
                retainResourceLeaseUntilExit();
                if (!error && result) {
                    resolve(result);
                    return;
                }
                reject(markUnprovenNativeTermination(
                    error ?? new Error(`${options.utilityName} process did not terminate cleanly.`),
                    `${options.utilityName} process (pid=${child.pid ?? 'unknown'}) was not proven dead`,
                ));
                return;
            }
            releaseResourceLease();
            if (error) reject(error); else resolve(result!);
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
        child.once('spawn', () => child.postMessage(options.request));
        child.once('message', (value) => {
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
            releaseResourceLease();
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
