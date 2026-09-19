import type { Page } from 'puppeteer-core';
import type {
    IViewerInvariantReport,
    IViewerInvariantViolation,
    TViewerInvariantId,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

// The Settled definition in docs/architecture/behavior-contract.md.
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * A violation a test accepts at one checkpoint. The reason names the defect,
 * so an exception is a record of a known bug rather than a weakened invariant.
 */
export interface IViewerInvariantException {
    id: TViewerInvariantId;
    reason: string;
}

export interface IAssertViewerInvariantsOptions {
    /** Names the moment in the journey, used in the failure message. */
    checkpoint: string;
    /** Violations this checkpoint tolerates, each with a written reason. */
    expected?: readonly IViewerInvariantException[];
    /** Annotations just edited, excluded once from the drift comparison. */
    editedAnnotationIds?: readonly string[];
    /** Enables C2 for a fixture the test knows is well formed. */
    documentWellFormed?: boolean;
    /** Requires a `navigation-idle` event after a navigation was driven. */
    requireNavigationIdle?: boolean;
    settleTimeoutMs?: number;
}

export interface IViewerInvariantCheckpointResult {
    report: IViewerInvariantReport;
    /** Expected violations that actually occurred at this checkpoint. */
    tolerated: IViewerInvariantViolation[];
}

function formatViolation(violation: IViewerInvariantViolation) {
    return `  - ${violation.id}: ${violation.message}\n      ${JSON.stringify(violation.evidence)}`;
}

/**
 * Waits for the viewer to settle, runs the app's own invariant checker through
 * the automation handle installed next to `__evbTestApi`, and fails with the
 * violation list. A checker that cannot be reached is a failure too: a silent
 * pass would be worse than no check.
 */
export async function assertViewerInvariants(
    page: Page,
    options: IAssertViewerInvariantsOptions,
): Promise<IViewerInvariantCheckpointResult> {
    const report = await evaluateInPage(page, async (input: {
        documentWellFormed: boolean;
        editedAnnotationIds: string[];
        requireNavigationIdle: boolean;
        settleTimeoutMs: number;
    }) => {
        interface IViewerInvariantSettleOutcome {
            reason: string | null;
            settled: boolean;
        }
        interface IViewerInvariantHandle {
            checkNow: (checkOptions: Record<string, unknown>) => IViewerInvariantReport;
            waitForSettled: (settleOptions: Record<string, unknown>) => Promise<IViewerInvariantSettleOutcome>;
        }
        const invariants = (window as Window & {__evbViewerInvariants?: IViewerInvariantHandle})
            .__evbViewerInvariants;
        if (!invariants) {
            throw new Error('The viewer invariant handle is not installed on this renderer');
        }
        const settle = await invariants.waitForSettled({
            requireNavigationIdle: input.requireNavigationIdle,
            timeoutMs: input.settleTimeoutMs,
        });
        return invariants.checkNow({
            documentWellFormed: input.documentWellFormed,
            editedAnnotationIds: input.editedAnnotationIds,
            settleFailure: settle.settled ? null : settle.reason,
        });
    }, {
        documentWellFormed: options.documentWellFormed ?? false,
        editedAnnotationIds: [...(options.editedAnnotationIds ?? [])],
        requireNavigationIdle: options.requireNavigationIdle ?? false,
        settleTimeoutMs: options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    });

    const expectedIds = new Set((options.expected ?? []).map(exception => exception.id));
    const tolerated = report.violations.filter(violation => expectedIds.has(violation.id));
    const unexpected = report.violations.filter(violation => !expectedIds.has(violation.id));
    if (unexpected.length > 0) {
        throw new Error([
            `Viewer invariants failed at checkpoint "${options.checkpoint}":`,
            ...unexpected.map(formatViolation),
            `  not applicable here: ${report.skipped.map(skip => skip.id).join(', ') || 'none'}`,
        ].join('\n'));
    }

    return {
        report,
        tolerated,
    };
}

/** Starts a new two-observation sequence, for a test that resets the viewer. */
export async function resetViewerInvariantObservations(page: Page) {
    await evaluateInPage(page, () => {
        (window as Window & {__evbViewerInvariants?: {resetMemory: () => void}})
            .__evbViewerInvariants?.resetMemory();
    });
}
