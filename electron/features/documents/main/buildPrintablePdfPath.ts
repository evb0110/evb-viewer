import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess } from 'electron';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import type { IPdfPathPrintOptions } from '@contracts/electronApiDocuments';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { terminateProcessTree } from '@electron/utils/processTree';
import { markUnprovenNativeTermination } from '@electron/utils/nativeTerminationProof';
import { PDF_PRINT_LAYOUT_SERVICE_NAME } from '@electron/processDeathRecovery';
import { decodePdfPrintLayoutUtilityResult } from '@electron/features/documents/main/pdfPrintLayoutUtilityProtocol';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { resolvePdfPrintLayoutAdmission } from '@electron/features/documents/main/resolvePdfPrintLayoutAdmission';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_PRINT_LAYOUT_TIMEOUT_MS = 10 * 60_000;

export async function buildPrintablePdfPath(options: {
    inputPath: string;
    outputPath: string;
    printOptions: IPdfPathPrintOptions;
    signal?: AbortSignal;
}) {
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const admission = resolvePdfPrintLayoutAdmission();
    const lease = await mainJobBroker.acquire({
        ownerId: `pdf-print-layout:${options.inputPath}`,
        kind: 'pdf-print-layout',
        priority: 'foreground',
        admissionClass: 'bulk',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: admission.estimatedResidentBytes,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        ...(options.signal ? {signal: options.signal} : {}),
    });
    try {
        return await runPdfPrintLayoutUtility(options, admission.childMaxOldSpaceMib);
    } finally {
        lease.release();
    }
}

function runPdfPrintLayoutUtility(
    options: {
        inputPath: string;
        outputPath: string;
        printOptions: IPdfPathPrintOptions;
        signal?: AbortSignal;
    },
    childMaxOldSpaceMib: number,
) {
    const workerPath = resolveUnpackedWorkerPath(
        __dirname,
        WORKER_BUNDLES_BY_ID['pdf-print-layout'].fileName,
    );
    return new Promise<{bytes: number}>((resolve, reject) => {
        const child = utilityProcess.fork(workerPath, [], {
            cwd: dirname(options.inputPath),
            serviceName: PDF_PRINT_LAYOUT_SERVICE_NAME,
            stdio: 'ignore',
            execArgv: [`--max-old-space-size=${String(childMaxOldSpaceMib)}`],
        });
        let settled = false;
        let childExited = false;
        const stopChild = async () => {
            const pid = child.pid;
            if (pid === undefined) {
                return true;
            }
            return terminateProcessTree(pid, {
                graceMs: 2_500,
                isTargetAlive: () => child.pid === pid && !childExited,
                preferProcessGroup: false,
            });
        };
        const finish = async (error?: Error, result?: {bytes: number}) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            const terminated = await stopChild();
            if (!terminated && error) {
                reject(markUnprovenNativeTermination(
                    error,
                    `PDF print layout utility process (pid=${child.pid ?? 'unknown'}) was not proven dead`,
                ));
                return;
            }
            if (error) {
                reject(error);
                return;
            }
            resolve(result!);
        };
        const abort = () => {
            void finish(abortErrorFromSignal(options.signal!));
        };
        const timeout = setTimeout(() => {
            void finish(new Error('PDF print layout preparation timed out'));
        }, PDF_PRINT_LAYOUT_TIMEOUT_MS);
        timeout.unref();
        options.signal?.addEventListener('abort', abort, {once: true});
        child.once('spawn', () => child.postMessage({
            inputPath: options.inputPath,
            outputPath: options.outputPath,
            viewMode: options.printOptions.viewMode,
            orientation: options.printOptions.orientation,
            ...(options.printOptions.pageNumbers === undefined
                ? {}
                : {pageNumbers: options.printOptions.pageNumbers}),
        }));
        child.once('message', (value) => {
            const result = decodePdfPrintLayoutUtilityResult(value);
            if (!result) {
                void finish(new Error('PDF print layout utility returned an invalid result'));
                return;
            }
            if (!result.ok) {
                void finish(new Error(result.error));
                return;
            }
            void finish(undefined, {bytes: result.bytes});
        });
        child.once('error', (_type, location) => {
            void finish(new Error(`PDF print layout utility failed at ${location}`));
        });
        child.once('exit', code => {
            childExited = true;
            if (!settled) {
                const detail = `with exit code ${code}`;
                void finish(new Error(
                    `PDF print layout utility exited before completion ${detail}. Close other documents or print a smaller page range, then try again.`,
                ));
            }
        });
    });
}
