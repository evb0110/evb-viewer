import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {chainJobBrokerRunContext, type IJobBrokerRunContext} from '@electron/resources/jobBroker';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {
    detectSourceDpi as detectCoreSourceDpi,
    detectSourceDpiDetails as detectCoreSourceDpiDetails,
    type TSourceDpiLog,
} from '@evb/scan-cleanup/core/sourceDpiDetection';
import type {TScanCleanupRunCommand} from '@evb/scan-cleanup/core/types';
export {detectSourceDpiFromPageSizes} from '@evb/scan-cleanup/core/types';
export type {TSourceDpiLog};

function createBrokerBoundRunCommand(
    brokerRun: IJobBrokerRunContext | undefined,
    runCommand?: TScanCleanupRunCommand,
): TScanCleanupRunCommand {
    if (runCommand !== undefined) {
        return runCommand;
    }
    if (brokerRun === undefined) {
        return runNativeToolCommand;
    }
    const maxConcurrency = Math.floor(brokerRun.lease.resources.nativeProcesses);
    if (maxConcurrency < 1) {
        return runNativeToolCommand;
    }
    let active = 0;
    let unprovenFailure: unknown = null;
    const waiters: Array<{
        grant: () => void;
        fail: (error: unknown) => void;
    }> = [];
    const acquireSlot = (signal: AbortSignal | undefined) => {
        if (unprovenFailure !== null) {
            return Promise.reject(unprovenFailure);
        }
        if (active < maxConcurrency) {
            active += 1;
            return Promise.resolve();
        }
        if (signal?.aborted) {
            return Promise.reject(abortErrorFromSignal(signal));
        }
        return new Promise<void>((resolve, reject) => {
            const removeWaiter = () => {
                const index = waiters.indexOf(entry);
                if (index >= 0) {
                    waiters.splice(index, 1);
                }
            };
            const onAbort = () => {
                removeWaiter();
                reject(abortErrorFromSignal(signal!));
            };
            const entry = {
                grant: () => {
                    signal?.removeEventListener('abort', onAbort);
                    active += 1;
                    resolve();
                },
                fail: (error: unknown) => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(error);
                },
            };
            signal?.addEventListener('abort', onAbort, {once: true});
            waiters.push(entry);
        });
    };
    const releaseSlot = () => {
        active = Math.max(0, active - 1);
        if (unprovenFailure !== null) {
            const failure = unprovenFailure;
            while (waiters.length > 0) {
                waiters.shift()!.fail(failure);
            }
            return;
        }
        waiters.shift()?.grant();
    };
    return async (command, args, options) => {
        const {onTerminationProof: innerProof, ...restOptions} = options ?? {};
        await acquireSlot(restOptions.signal);
        let slotUnproven = false;
        try {
            return await runNativeToolCommand(command, args, {
                ...restOptions,
                brokerRun: chainJobBrokerRunContext(brokerRun, innerProof),
            });
        } catch (error) {
            const hasUnprovenTermination =
                getUnprovenNativeTerminationDetail(error) !== undefined ||
                (error instanceof Error && getUnprovenNativeTerminationDetail(error.cause) !== undefined);
            if (hasUnprovenTermination) {
                slotUnproven = true;
                unprovenFailure ??= error;
                while (waiters.length > 0) {
                    waiters.shift()!.fail(unprovenFailure);
                }
            }
            throw error;
        } finally {
            if (!slotUnproven) {
                releaseSlot();
            }
        }
    };
}

export function detectSourceDpiDetails(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
    onProgress?: (completedPages: number, totalPages: number) => void,
    runCommand?: TScanCleanupRunCommand,
    brokerRun?: IJobBrokerRunContext,
) {
    return detectCoreSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        log,
        commandEnv,
        signal,
        pages,
        onProgress,
        createBrokerBoundRunCommand(brokerRun, runCommand),
    );
}

export function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
    brokerRun?: IJobBrokerRunContext,
) {
    return detectCoreSourceDpi(pdfPath, pdfimagesBinary, log, commandEnv, signal, pages, createBrokerBoundRunCommand(brokerRun));
}
