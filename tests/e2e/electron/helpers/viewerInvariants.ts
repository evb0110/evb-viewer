import type { Page } from 'puppeteer-core';
import type {
    IViewerInvariantReport,
    IViewerInvariantUnresolved,
    IViewerInvariantViolation,
    TViewerInvariantId,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

// The Settled definition in docs/architecture/behavior-contract.md.
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * A violation a test accepts at one checkpoint. The reason names the defect,
 * so an exception is a record of a known bug rather than a weakened invariant.
 * `annotationId` names the subject the tolerated violation must be about; a
 * violation of the same id about anything else is a different defect.
 */
export interface IViewerInvariantException {
    annotationId?: string;
    id: TViewerInvariantId;
    reason: string;
}

export interface IAssertViewerInvariantsOptions {
    /** Names the moment in the journey, used in the failure message. */
    checkpoint: string;
    /**
     * The exact violations this checkpoint tolerates, each with a written
     * reason. The list is matched in both directions: an unlisted violation
     * fails the checkpoint, and a listed one that did not occur fails it too,
     * so a fix cannot leave a stale exception behind.
     */
    expected?: readonly IViewerInvariantException[];
    /** Annotations just edited, excluded once from the drift comparison. */
    editedAnnotationIds?: readonly string[];
    /** Enables C2 for a fixture the test knows is well formed. */
    documentWellFormed?: boolean;
    /** Requires a `navigation-idle` event after a navigation was driven. */
    requireNavigationIdle?: boolean;
    /**
     * Invariants this checkpoint is about. Each one must have run: a skipped
     * check is not a pass, and a checkpoint whose subject was not applicable
     * has not observed what it claims to. The failure names the skip reason.
     */
    requireRan?: readonly TViewerInvariantId[];
    /**
     * Work the scenario created and has not deleted. The checker cannot judge
     * this: an annotation that is gone may have been deleted on purpose. The
     * scenario knows it only zoomed, so it says what must still be there.
     */
    requirePresent?: IViewerRequiredIdentities;
    settleTimeoutMs?: number;
}

export interface IViewerRequiredIdentities {
    /** Overlays that must be mounted. Their pages must be mounted too. */
    annotationIds?: readonly string[];
    /** Annotations whose note window must still be open. */
    noteWindowFor?: readonly string[];
    /** The toolbar must render a readable physical page number. */
    pageIndicator?: true;
}

export interface IViewerInvariantCheckpointResult {
    report: IViewerInvariantReport;
    /** Expected violations that actually occurred at this checkpoint. */
    tolerated: IViewerInvariantViolation[];
    /** Observations whose expected behavior the contract leaves open. */
    unresolved: IViewerInvariantUnresolved[];
}

function formatViolation(violation: IViewerInvariantViolation) {
    return `  - ${violation.id}: ${violation.message}\n      ${JSON.stringify(violation.evidence)}`;
}

/** Identifies a violation by what it is about, not only by its statement. */
function describeSubject(id: TViewerInvariantId, annotationId: string | null) {
    return `${id} on ${annotationId ?? 'the viewer'}`;
}

function subjectOfViolation(violation: IViewerInvariantViolation) {
    const annotationId = violation.evidence.annotationId;
    return describeSubject(violation.id, typeof annotationId === 'string' ? annotationId : null);
}

function describeUnmetRequirements(
    report: IViewerInvariantReport,
    options: IAssertViewerInvariantsOptions,
) {
    const unmet: string[] = [];
    for (const id of options.requireRan ?? []) {
        const skip = report.skipped.find(entry => entry.id === id);
        if (skip) {
            unmet.push(`${id} did not run: ${skip.reason}`);
        }
    }

    const required = options.requirePresent;
    if (!required) {
        return unmet;
    }
    for (const annotationId of required.annotationIds ?? []) {
        if (!report.observed.annotationIds.includes(annotationId)) {
            unmet.push(`the annotation ${annotationId} is no longer drawn;`
                + ` mounted pages ${report.observed.mountedPageNumbers.join(', ') || 'none'},`
                + ` drawn annotations ${report.observed.annotationIds.join(', ') || 'none'}`);
        }
    }
    for (const annotationId of required.noteWindowFor ?? []) {
        if (!report.observed.noteWindowAnnotationIds.includes(annotationId)) {
            unmet.push(`the note window for ${annotationId} is no longer open;`
                + ` open windows ${report.observed.noteWindowAnnotationIds.join(', ') || 'none'}`);
        }
    }
    if (required.pageIndicator && report.observed.pageIndicator === null) {
        unmet.push('the toolbar rendered no readable page number');
    }
    return unmet;
}

/**
 * Decides a checkpoint from a report the app produced. Kept apart from the
 * page plumbing so the decision itself can be exercised against a report built
 * in a browser fixture.
 */
export function evaluateViewerInvariantCheckpoint(
    report: IViewerInvariantReport,
    options: IAssertViewerInvariantsOptions,
): IViewerInvariantCheckpointResult {
    const outstanding = (options.expected ?? []).map(exception => (
        describeSubject(exception.id, exception.annotationId ?? null)
    ));
    const tolerated: IViewerInvariantViolation[] = [];
    const unexpected: IViewerInvariantViolation[] = [];
    for (const violation of report.violations) {
        const index = outstanding.indexOf(subjectOfViolation(violation));
        if (index === -1) {
            unexpected.push(violation);
            continue;
        }
        outstanding.splice(index, 1);
        tolerated.push(violation);
    }
    const unmet = describeUnmetRequirements(report, options);

    if (unexpected.length > 0 || outstanding.length > 0 || unmet.length > 0) {
        throw new Error([
            `Viewer invariants failed at checkpoint "${options.checkpoint}":`,
            ...unexpected.map(formatViolation),
            ...unmet.map(entry => `  - ${entry}`),
            ...(outstanding.length > 0
                ? [`  tolerated but not observed: ${outstanding.join(', ')}.`
                    + ' Either the defect is fixed and the exception belongs in the'
                    + ' bin, or this checkpoint no longer reaches it.']
                : []),
            `  not applicable here: ${report.skipped.map(skip => skip.id).join(', ') || 'none'}`,
        ].join('\n'));
    }

    return {
        report,
        tolerated,
        unresolved: report.unresolved,
    };
}

/**
 * Waits for the viewer to settle, runs the app's own invariant checker through
 * the automation handle installed next to `__evbTestApi`, and fails with the
 * violation list. A checker that cannot be reached is a failure too: a silent
 * pass would be worse than no check.
 *
 * The report's `unresolved` entries are returned, never failed on: they record
 * behavior the contract has not decided, and a test cannot turn an open product
 * question into an expectation.
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

    return evaluateViewerInvariantCheckpoint(report, options);
}

/** Starts a new two-observation sequence, for a test that resets the viewer. */
export async function resetViewerInvariantObservations(page: Page) {
    await evaluateInPage(page, () => {
        (window as Window & {__evbViewerInvariants?: {resetMemory: () => void}})
            .__evbViewerInvariants?.resetMemory();
    });
}
