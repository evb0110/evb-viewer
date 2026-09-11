import type { ILogger } from '@electron/utils/createLogger';
import {
    GPU_SAFE_MODE_CRASH_COUNT_MAX,
    GPU_SAFE_MODE_CRASH_COUNT_MIN,
    normalizeProcessGoneExitCode,
    normalizeProcessGoneReason,
    normalizeProcessGoneType,
} from '@contracts/diagnostics/diagnosticCodes';
import type {
    DiagnosticCode,
    DiagnosticContext,
} from '@contracts/diagnostics/diagnosticCodes';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';

export const PROCESS_SAFE_MODE_ARGUMENT = '--evb-safe-mode';
const GPU_CRASH_WINDOW_MS = 5 * 60 * 1_000;
const GPU_CRASH_RELAUNCH_THRESHOLD = 2;

interface IProcessSafeModeApp {commandLine: {appendSwitch(name: string): void};}

interface IChildProcessGoneDetails {
    type: string;
    reason: string;
    exitCode: number;
    name?: string;
    serviceName?: string;
}

type IProcessGoneContext = DiagnosticContext<'MAIN_CHILD_PROCESS_GONE'>;
type IGpuRecoveryContext = DiagnosticContext<'MAIN_GPU_SAFE_MODE_RECOVERY'>;

interface IProcessDeathRecoveryOptions {
    argv: string[];
    logger: Pick<ILogger, 'error' | 'warn'>;
    now?: () => number;
    requestSafeModeRelaunch: (args: string[]) => void;
    captureFailure?: <C extends DiagnosticCode>(input: CaptureFailureInput<C>) => FailureReceipt | undefined;
}

/**
 * `serviceName` of the only Electron utility processes this app forks. Both
 * come from `runDocumentSaveUtilityProcess`, which is the single
 * `utilityProcess.fork` call site in the app, and both are read back here to
 * recognise the app's own teardown. Every other child process the app starts is
 * a Node `child_process`, which Chromium never reports through
 * `child-process-gone`.
 */
export const DOCUMENT_FINGERPRINT_SERVICE_NAME = 'EVB document fingerprint';
export const DOCUMENT_SAVE_SERVICE_NAME = 'EVB document save';
export const PDF_PRINT_LAYOUT_SERVICE_NAME = 'EVB PDF print layout';

const APP_TERMINATED_UTILITY_IDENTITIES: ReadonlySet<string> = new Set([
    DOCUMENT_FINGERPRINT_SERVICE_NAME,
    DOCUMENT_SAVE_SERVICE_NAME,
    PDF_PRINT_LAYOUT_SERVICE_NAME,
]);

/**
 * Whether this death is an app-owned utility process that the app itself ended.
 *
 * `runDocumentSaveUtilityProcess` kills its child as ordinary teardown the
 * moment the worker has answered, so `killed` carries no fault signal for those
 * two identities. The test is deliberately an allowlist rather than "any killed
 * non-GPU process": a Utility process the app did not fork, a Zygote, a sandbox
 * helper or a plugin host is only ever killed by something outside the app, and
 * that is worth reporting.
 *
 * `utilityProcess.fork` documents its `serviceName` option as surfacing in the
 * `name` field of this event, while Chromium fills `serviceName` with the mojo
 * service identity. Both fields are matched so the rule does not depend on which
 * one a given Electron build populates.
 */
function isAppTerminatedUtilityProcess(details: IChildProcessGoneDetails) {
    if (details.type !== 'Utility' || details.reason !== 'killed') {
        return false;
    }
    return APP_TERMINATED_UTILITY_IDENTITIES.has(details.name ?? '')
        || APP_TERMINATED_UTILITY_IDENTITIES.has(details.serviceName ?? '');
}

function clampGpuCrashCount(crashCount: number) {
    return Math.min(
        GPU_SAFE_MODE_CRASH_COUNT_MAX,
        Math.max(GPU_SAFE_MODE_CRASH_COUNT_MIN, crashCount),
    );
}

export function configureProcessSafeMode(app: IProcessSafeModeApp, argv: string[]) {
    if (!argv.includes(PROCESS_SAFE_MODE_ARGUMENT)) {
        return false;
    }
    app.commandLine.appendSwitch('disable-gpu');
    return true;
}

export function createProcessDeathRecovery(options: IProcessDeathRecoveryOptions) {
    const now = options.now ?? Date.now;
    let gpuCrashTimestamps: number[] = [];
    let safeModeRelaunchRequested = false;

    function reportFailure<C extends DiagnosticCode>(
        code: C,
        context: DiagnosticContext<C>,
        message: string,
        cause?: unknown,
    ) {
        let receipt: FailureReceipt | undefined;
        try {
            receipt = options.captureFailure?.({
                code,
                operation: 'main-error',
                context,
                local: {
                    source: 'process-death',
                    message,
                    cause,
                },
            });
        } catch {
            // Diagnostics must not change process-death handling or recovery.
        }
        if (receipt === undefined) {
            options.logger.error(message, {
                code: 'MAIN_PROCESS_RECOVERY_FAILED',
                context: {},
            });
        } else {
            options.logger.error(message, receipt);
        }
        return receipt;
    }

    function getChildProcessContext(details: IChildProcessGoneDetails): IProcessGoneContext {
        const exitCode = normalizeProcessGoneExitCode(details.exitCode);
        return {
            processType: normalizeProcessGoneType(details.type),
            reason: normalizeProcessGoneReason(details.reason),
            ...(exitCode === undefined ? {} : {exitCode}),
        };
    }

    function getGpuRecoveryContext(
        safeMode: boolean,
        action: NonNullable<IGpuRecoveryContext['action']>,
        crashCount: number,
    ): IGpuRecoveryContext {
        return {
            safeMode,
            action,
            crashCount: clampGpuCrashCount(crashCount),
        };
    }

    function handleChildProcessGone(details: IChildProcessGoneDetails) {
        const identity = details.name ?? details.serviceName ?? details.type;
        const message = `[process-death] ${details.type} process gone (${identity}, reason=${details.reason}, exitCode=${details.exitCode})`;
        // Error level is what the renderer turns into a user-visible diagnostic
        // report, so leaving the app's own utility teardown there raised a
        // report for every successful fingerprint and every successful save.
        // The event still belongs in the log; only the channel changes. Every
        // other non-renderer death, killed or not, keeps error level, including
        // the GPU, whose deaths drive the safe-mode relaunch below.
        // Electron also emits this app-level event for renderer deaths. The
        // webContents listener owns that occurrence so the same death cannot
        // create both a child-process and renderer-process receipt.
        if (details.type === 'Renderer' || isAppTerminatedUtilityProcess(details)) {
            options.logger.warn(message);
            return {action: 'logged' as const};
        }
        if (details.type !== 'GPU') {
            reportFailure('MAIN_CHILD_PROCESS_GONE', getChildProcessContext(details), message);
            return {action: 'logged' as const};
        }

        const cutoff = now() - GPU_CRASH_WINDOW_MS;
        gpuCrashTimestamps = gpuCrashTimestamps.filter(timestamp => timestamp >= cutoff);
        gpuCrashTimestamps.push(now());
        if (gpuCrashTimestamps.length < GPU_CRASH_RELAUNCH_THRESHOLD) {
            reportFailure('MAIN_CHILD_PROCESS_GONE', getChildProcessContext(details), message);
            return {action: 'logged' as const};
        }
        if (options.argv.includes(PROCESS_SAFE_MODE_ARGUMENT)) {
            reportFailure(
                'MAIN_GPU_SAFE_MODE_RECOVERY',
                getGpuRecoveryContext(true, 'failed', gpuCrashTimestamps.length),
                '[process-death] GPU failed repeatedly while software-rendering safe mode was active',
            );
            return {action: 'safe-mode-failed' as const};
        }
        if (safeModeRelaunchRequested) {
            options.logger.warn(message);
            return {action: 'safe-mode-relaunch-pending' as const};
        }

        const relaunchArgs = [
            ...options.argv.slice(1).filter(argument => argument !== PROCESS_SAFE_MODE_ARGUMENT),
            PROCESS_SAFE_MODE_ARGUMENT,
        ];
        safeModeRelaunchRequested = true;
        reportFailure(
            'MAIN_GPU_SAFE_MODE_RECOVERY',
            getGpuRecoveryContext(false, 'relaunch', gpuCrashTimestamps.length),
            message,
        );
        options.logger.warn('[process-death] Relaunching in software-rendering safe mode after repeated GPU crashes');
        options.requestSafeModeRelaunch(relaunchArgs);
        return {action: 'safe-mode-relaunch' as const};
    }

    return {handleChildProcessGone};
}
