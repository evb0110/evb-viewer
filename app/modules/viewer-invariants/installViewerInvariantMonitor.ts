import packageJson from '@root-package';
import type { IHostBugReportWriteResult } from '@contracts/hostPlatformFeature';
import { BrowserLogger } from '@app/utils/browserLogger';
import { captureViewerBugReport } from '@app/modules/viewer-invariants/captureViewerBugReport';
import {
    checkViewerInvariants,
    resetViewerInvariantMemory,
} from '@app/modules/viewer-invariants/checkViewerInvariants';
import {
    disposeViewerActionLog,
    installViewerActionLog,
    readViewerUserActions,
} from '@app/modules/viewer-invariants/viewerActionLog';
import { disposeViewerDiagnosticLog } from '@app/modules/viewer-invariants/viewerDiagnosticLog';
import {
    waitForViewerSettled,
    type IViewerSettleOptions,
    type IViewerSettleOutcome,
} from '@app/modules/viewer-invariants/waitForViewerSettled';
import type {
    IViewerInvariantOptions,
    IViewerInvariantReport,
    IViewerInvariantUnresolved,
    IViewerInvariantViolation,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';

/** One check per settled state at most, so ordinary use stays unaffected. */
const CHECK_THROTTLE_MS = 1_000;
const MAX_RETAINED_VIOLATIONS = 40;
const SETTLE_POLL_TIMEOUT_MS = 4_000;
const BUG_REPORT_SHORTCUT_CODE = 'KeyB';

export interface IViewerInvariantMonitorHandle {
    captureBugReport: () => Promise<void>;
    checkNow: (options?: IViewerInvariantOptions) => IViewerInvariantReport;
    dispose: () => void;
    readUnresolved: () => readonly IViewerInvariantUnresolved[];
    readViolations: () => readonly IViewerInvariantViolation[];
    resetMemory: () => void;
    waitForSettled: (options?: IViewerSettleOptions) => Promise<IViewerSettleOutcome>;
}

/** Shows the confirmation for a written bundle. */
export interface IViewerInvariantMonitorOptions {announceBugReport?: (result: IHostBugReportWriteResult) => void;}

interface IViewerInvariantWindow extends Window {__evbViewerInvariants?: IViewerInvariantMonitorHandle;}

let installed: IViewerInvariantMonitorHandle | null = null;

function isBugReportShortcut(event: KeyboardEvent) {
    return event.code === BUG_REPORT_SHORTCUT_CODE
        && event.altKey
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey;
}

/**
 * Watches ordinary development use: on every settled state it runs the
 * invariant checker once, keeps a bounded tail of what the user did and of
 * what broke, and logs one structured warning per violation. Nothing intrusive
 * appears on screen.
 */
export function installViewerInvariantMonitor(
    options: IViewerInvariantMonitorOptions = {},
): IViewerInvariantMonitorHandle {
    if (installed) {
        return installed;
    }

    const violations: IViewerInvariantViolation[] = [];
    const unresolved: IViewerInvariantUnresolved[] = [];
    let lastCheckAt = 0;
    let checkInFlight = false;
    let disposed = false;

    installViewerActionLog();

    function retainViolations(report: IViewerInvariantReport) {
        for (const violation of report.violations) {
            violations.push(violation);
            BrowserLogger.warn('viewer-invariants', violation.message, {
                evidence: violation.evidence,
                id: violation.id,
                recentActions: readViewerUserActions().slice(-5),
            });
        }
        if (violations.length > MAX_RETAINED_VIOLATIONS) {
            violations.splice(0, violations.length - MAX_RETAINED_VIOLATIONS);
        }

        // An undecided rule cannot fail anything, so these are recorded and
        // reported at info level. They travel in the bug bundle unchanged.
        for (const observation of report.unresolved) {
            unresolved.push(observation);
            BrowserLogger.info('viewer-invariants', observation.question, {
                evidence: observation.evidence,
                id: observation.id,
            });
        }
        if (unresolved.length > MAX_RETAINED_VIOLATIONS) {
            unresolved.splice(0, unresolved.length - MAX_RETAINED_VIOLATIONS);
        }
    }

    function checkNow(checkOptions: IViewerInvariantOptions = {}) {
        const report = checkViewerInvariants(checkOptions);
        retainViolations(report);
        lastCheckAt = Date.now();
        return report;
    }

    async function checkWhenSettled() {
        if (disposed || checkInFlight || Date.now() - lastCheckAt < CHECK_THROTTLE_MS) {
            return;
        }
        checkInFlight = true;
        try {
            const outcome = await waitForViewerSettled({timeoutMs: SETTLE_POLL_TIMEOUT_MS});
            if (disposed || !outcome.settled) {
                // A monitor watching ordinary use cannot tell a slow render
                // from an idle user, so an unsettled sample is dropped here
                // rather than reported. A test declares its own settle bound.
                return;
            }
            checkNow();
        } finally {
            checkInFlight = false;
        }
    }

    async function captureBugReport() {
        try {
            const result = await captureViewerBugReport(packageJson.version);
            options.announceBugReport?.(result);
        } catch (error) {
            BrowserLogger.warn('viewer-invariants', 'Bug report capture failed', {error});
        }
    }

    const handleSettleTrigger = () => {
        void checkWhenSettled();
    };
    const handleKeydown = (event: KeyboardEvent) => {
        if (!isBugReportShortcut(event)) {
            return;
        }
        event.preventDefault();
        void captureBugReport();
    };

    window.addEventListener('keydown', handleKeydown, {capture: true});
    for (const type of [
        'pointerup',
        'keyup',
        'wheel',
    ] as const) {
        window.addEventListener(type, handleSettleTrigger, {
            capture: true,
            passive: true,
        });
    }
    window.addEventListener('resize', handleSettleTrigger, {passive: true});

    const handle: IViewerInvariantMonitorHandle = {
        captureBugReport,
        checkNow,
        dispose: () => {
            disposed = true;
            window.removeEventListener('keydown', handleKeydown, {capture: true});
            for (const type of [
                'pointerup',
                'keyup',
                'wheel',
            ] as const) {
                window.removeEventListener(type, handleSettleTrigger, {capture: true});
            }
            window.removeEventListener('resize', handleSettleTrigger);
            disposeViewerActionLog();
            disposeViewerDiagnosticLog();
            resetViewerInvariantMemory();
            const target = window as IViewerInvariantWindow;
            if (target.__evbViewerInvariants === handle) {
                delete target.__evbViewerInvariants;
            }
            installed = null;
        },
        readUnresolved: () => unresolved,
        readViolations: () => violations,
        resetMemory: () => {
            violations.length = 0;
            unresolved.length = 0;
            resetViewerInvariantMemory();
        },
        waitForSettled: settleOptions => waitForViewerSettled(settleOptions),
    };

    // Installed next to `__evbTestApi` so automation reaches the same checker
    // the monitor runs, without a parallel implementation.
    (window as IViewerInvariantWindow).__evbViewerInvariants = handle;
    installed = handle;
    return handle;
}
