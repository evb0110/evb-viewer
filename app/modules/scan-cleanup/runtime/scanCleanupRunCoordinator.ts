import { getErrorMessage } from '@app/utils/error';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type {
    IScanCleanupStartRequest,
    IScanCleanupScratchShortfall,
    TScanCleanupStartResult as TBridgeScanCleanupStartResult,
    TScanCleanupJobClosure,
    TScanCleanupJobState,
    TScanCleanupErrorCode,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {isScanCleanupJobClosure} from '@contracts/scan-cleanup/ipc';
import type {TTranslateFn} from '@i18n-app';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    createJobId,
    parseJobId,
    type TJobId,
} from '@contracts/shared';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {BrowserLogger} from '@app/utils/browserLogger';
import {
    createFailureToastPresenter,
    type IFailureToastTarget,
} from '@app/composables/useFailureToast';
import {formatScanCleanupErrorByCode} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';
import {formatScanCleanupProgress} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {toPlainScanCleanupOptions} from '@contracts/scan-cleanup/scanCleanupSettings';
import {dismissScanCleanupFirstRunGuidanceInStore} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const ACTIVE_JOB_KEY = 'evb.scanCleanup.activeJobId';
const ACTIVE_JOB_DOCUMENT_KEY = 'evb.scanCleanup.activeDocumentRef';
const ACTIVE_JOB_OWNER_KEY = 'evb.scanCleanup.activeOwnerId';
const ACTIVE_JOB_REVISION_KEY = 'evb.scanCleanup.activeDocumentRevision';
/**
 * Probe the authoritative job record often enough to recover a dropped event,
 * while staying well below the main-process replay and terminal retention
 * windows. A slow conversion therefore gets several chances to answer before
 * an absent record can be treated as abandoned.
 */
export const SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS = 10_000;
/**
 * How long the coordinator keeps the completed run's guard, active job id, and
 * session persistence alive while the generated PDF is handed to the workspace.
 * Kept at the bounded document-open stage budget the workspace controller uses,
 * so a handoff that never answers fails the run instead of pinning it forever.
 */
const GENERATED_PDF_HANDOFF_TIMEOUT_MS = 30_000;

export type TScanCleanupRunReconciliationFailure = 'subscription' | 'recovery';

type TScanCleanupStartFallback = 'already-running' | 'unavailable';

export type TScanCleanupRendererStartResult =
    | Extract<TBridgeScanCleanupStartResult, {started: true}>
    | (Extract<TBridgeScanCleanupStartResult, {started: false}> & {fallback?: TScanCleanupStartFallback});

export class ScanCleanupRunReconciliationError extends Error {
    readonly errorCode: TScanCleanupErrorCode = 'internal';
    readonly failure: TScanCleanupRunReconciliationFailure;
    readonly technicalDetail: string;

    constructor(failure: TScanCleanupRunReconciliationFailure, technicalDetail = '') {
        super(technicalDetail);
        this.name = 'ScanCleanupRunReconciliationError';
        this.failure = failure;
        this.technicalDetail = technicalDetail;
    }
}
/**
 * The jobs whose terminal state this window has already acted on, so a state
 * replayed by a reconnect or delivered twice by the bridge does not open the
 * output, toast, or report the failure a second time.
 *
 * It is bounded because a long session runs many jobs and each one is only
 * worth remembering for as long as a duplicate of its terminal state can still
 * arrive — which is while it is the job the coordinator is talking about. The
 * oldest entry is dropped once the set is full: a job that far back cannot be
 * the active one, so it has nothing left to suppress.
 */
const terminalJobs = new Set<TJobId>();
const TERMINAL_JOB_MEMORY = 32;

function rememberTerminalJob(jobId: TJobId) {
    terminalJobs.add(jobId);
    while (terminalJobs.size > TERMINAL_JOB_MEMORY) {
        const oldest = terminalJobs.values().next();
        if (oldest.done) {
            return;
        }
        terminalJobs.delete(oldest.value);
    }
}

interface IScanCleanupRunError {
    documentRevision: string | null;
    error: string;
    errorCode: TScanCleanupErrorCode;
    ownerId: string;
    sourceDocumentRef: string | null;
    scratchShortfall?: IScanCleanupScratchShortfall;
    failure?: FailureReceipt;
}

const workspaceOwners = new Map<string, () => boolean>();

export const scanCleanupRun = reactive({
    activeJobId: null as TJobId | null,
    inFlight: false,
    /** The owners whose cleanup workspace is visible now. */
    workspaceOwnerIds: {
        has: (ownerId: string) => workspaceOwners.get(ownerId)?.() === true,
        clear: () => workspaceOwners.clear(),
    },
    jobState: null as TScanCleanupJobState | null,
    lastError: null as IScanCleanupRunError | null,
    ownerDocumentRef: null as string | null,
    ownerDocumentRevision: null as string | null,
    ownerId: null as string | null,
});

export const isScanCleanupRunning = computed(() => scanCleanupRun.inFlight || Boolean(
    scanCleanupRun.activeJobId
    && scanCleanupRun.jobState
    && isLiveScanCleanupJobState(scanCleanupRun.jobState),
));

/**
 * The scan cleanup trigger of one document's toolbar or menu. The window holds
 * one run; a document shows it only when it owns it, never another
 * document's run as its own activity.
 */
export function describeScanCleanupTrigger(documentRef: string | null, totalPages: number, t: TTranslateFn) {
    const running = Boolean(documentRef)
        && isScanCleanupRunning.value
        && scanCleanupRun.ownerDocumentRef === documentRef;
    if (!documentRef) {
        return {
            running,
            label: t('scanCleanup.noDocument'),
        };
    }
    return {
        running,
        label: running
            ? formatScanCleanupProgress(scanCleanupRun.jobState?.progress ?? {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: Math.max(1, totalPages),
            }, t).text
            : t('scanCleanup.button'),
    };
}

function scanCleanupRunErrorMatches(
    ownerId: string,
    sourceDocumentRef?: string | null,
    documentRevision?: string | null,
) {
    const lastError = scanCleanupRun.lastError;
    return lastError !== null && (lastError.ownerId === ownerId || Boolean(
        sourceDocumentRef
        && documentRevision
        && lastError.sourceDocumentRef === sourceDocumentRef
        && lastError.documentRevision === documentRevision,
    ));
}

export function getScanCleanupRunError(
    ownerId: string,
    sourceDocumentRef?: string | null,
    documentRevision?: string | null,
) {
    return scanCleanupRunErrorMatches(ownerId, sourceDocumentRef, documentRevision)
        ? scanCleanupRun.lastError?.error ?? ''
        : '';
}

export function getScanCleanupRunFailure(
    ownerId: string,
    sourceDocumentRef?: string | null,
    documentRevision?: string | null,
) {
    return scanCleanupRunErrorMatches(ownerId, sourceDocumentRef, documentRevision)
        ? scanCleanupRun.lastError?.failure
        : undefined;
}

export function getScanCleanupRunErrorCode(
    ownerId: string,
    sourceDocumentRef?: string | null,
    documentRevision?: string | null,
) {
    return scanCleanupRunErrorMatches(ownerId, sourceDocumentRef, documentRevision)
        ? scanCleanupRun.lastError?.errorCode ?? null
        : null;
}

export function setScanCleanupRunError(
    ownerId: string,
    error: string,
    errorCode: TScanCleanupErrorCode = 'internal',
    sourceDocumentRef: string | null = scanCleanupRun.ownerDocumentRef,
    documentRevision: string | null = scanCleanupRun.ownerDocumentRevision,
    failure?: FailureReceipt,
    scratchShortfall?: IScanCleanupScratchShortfall,
) {
    scanCleanupRun.lastError = error ? {
        documentRevision,
        error,
        errorCode,
        ownerId,
        sourceDocumentRef,
        ...(scratchShortfall === undefined ? {} : {scratchShortfall}),
        ...(failure === undefined ? {} : {failure}),
    } : null;
}

export function reportScanCleanupRunError(
    ownerId: string,
    error: string,
    sourceDocumentRef: string | null = scanCleanupRun.ownerDocumentRef,
    errorCode: TScanCleanupErrorCode = 'internal',
    sourceDocumentRevision: string | null = scanCleanupRun.ownerDocumentRevision,
    existingFailure?: FailureReceipt,
    scratchShortfall?: IScanCleanupScratchShortfall,
) {
    const failure = existingFailure ?? BrowserLogger.error(
        'scan-cleanup',
        'Scan cleanup run failed',
        error,
        {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'},
    );
    setScanCleanupRunError(
        ownerId,
        error,
        errorCode,
        sourceDocumentRef,
        sourceDocumentRevision,
        failure,
        scratchShortfall,
    );
    if (!dependencies) {
        return;
    }
    const workspaceIsOpen = scanCleanupRun.workspaceOwnerIds.has(ownerId);
    createFailureToastPresenter(dependencies.toast, dependencies.t)({
        failure,
        title: dependencies.t('scanCleanup.failed'),
        description: error,
        ...(!workspaceIsOpen && sourceDocumentRef ? {actions: [{
            label: dependencies.t('scanCleanup.details'),
            color: 'neutral' as const,
            variant: 'outline' as const,
            onClick: () => { void dependencies?.openScanCleanupForDocument?.(sourceDocumentRef); },
        }]} : {}),
    });
}

export function resolveScanCleanupProcessedPages(
    state: TScanCleanupJobState | null,
    ownerDocumentRef: string | null,
    sourceDocumentRef: string | null,
    totalPages: number,
): ReadonlySet<number> {
    if (
        !state
        || !sourceDocumentRef
        || ownerDocumentRef !== sourceDocumentRef
        || !isLiveScanCleanupJobState(state)
    ) {
        return new Set();
    }
    // A truncated progress list is still the only source of page identity.
    // `completedUnits` is a count and cannot identify pages in a sparse
    // selection such as [100, 200].
    return new Set((state.progress.completedPageNumbers ?? [])
        .filter(pageNumber => pageNumber <= totalPages));
}

type IScanCleanupToast = IFailureToastTarget;

export interface IScanCleanupCoordinatorDependencies {
    /**
     * Opens a run's output. A run finishing now (`foreground`) shows it; an
     * output replayed from the completed journal is placed behind the tab the
     * reader is in.
     */
    openGeneratedPdf: (path: string, signal: AbortSignal, foreground: boolean) => Promise<boolean>;
    createCompletedOutputSaveAs: (outputPath: string) => () => Promise<unknown>;
    openScanCleanupForDocument?: (documentRef: string) => Promise<boolean> | boolean;
    t: TTranslateFn;
    /** The app's language now, for the numbers a message carries. */
    locale: () => string;
    toast: IScanCleanupToast;
}

interface IScanCleanupCoordinatorInstallation {
    dependencies: IScanCleanupCoordinatorDependencies;
    active: boolean;
}

const installations: IScanCleanupCoordinatorInstallation[] = [];
/** The live job subscription. Work begun under it compares it after each await. */
let unsubscribe: (() => void) | null = null;
let dependencies: IScanCleanupCoordinatorDependencies | null = null;
let pendingStart: Pick<IScanCleanupStartRequest, 'documentRevision' | 'ownerId' | 'sourcePdfPath'> | null = null;
let startRequestPromise: Promise<TScanCleanupRendererStartResult> | null = null;
let activeStartResult: Extract<TBridgeScanCleanupStartResult, {started: true}> | null = null;
let runLivenessTimer: ReturnType<typeof setTimeout> | null = null;
let runLivenessGeneration = 0;

type TGeneratedPdfHandoffReason = 'opened' | 'open-failed' | 'timed-out' | 'disposed';

/**
 * One generated PDF on its way to the viewer, from the moment it is queued
 * until its slot is released. Its signal is the one cancellation of the open;
 * its reason is written once, and the first writer wins.
 */
interface IGeneratedPdfHandoff {
    controller: AbortController;
    jobId: TJobId | null;
    outputPdfPath: string;
    reason: TGeneratedPdfHandoffReason | null;
    /** Settles when the record leaves the queue, admitting the one behind it. */
    released: PromiseWithResolvers<void>;
}

/** The handoffs in the order they open; the head is the one opening. */
const generatedPdfHandoffs: IGeneratedPdfHandoff[] = [];

function settleGeneratedPdfHandoff(handoff: IGeneratedPdfHandoff, reason: TGeneratedPdfHandoffReason) {
    if (handoff.reason === null) {
        handoff.reason = reason;
        BrowserLogger.debug('scan-cleanup', 'Generated PDF handoff ended', {outputPdfPath: handoff.outputPdfPath, reason});
    }
    return handoff.reason;
}

function releaseGeneratedPdfHandoff(handoff: IGeneratedPdfHandoff) {
    const index = generatedPdfHandoffs.indexOf(handoff);
    if (index >= 0) generatedPdfHandoffs.splice(index, 1);
    handoff.released.resolve();
}

interface IGeneratedPdfHandoffResult {
    handoff: IGeneratedPdfHandoff;
    /** Settled by the caller in the turn it acts on it, so a disposal in between wins. */
    outcome: TGeneratedPdfHandoffReason;
    error?: unknown;
}

/**
 * Queues the record before anything is awaited and opens it once it is the
 * head: at once when nothing is opening. The open is bounded by the handoff
 * deadline, and a late answer is consumed without settling anything.
 */
async function openGeneratedPdfWithHandoff(
    openGeneratedPdf: IScanCleanupCoordinatorDependencies['openGeneratedPdf'],
    outputPdfPath: string,
    jobId: TJobId | null,
): Promise<IGeneratedPdfHandoffResult> {
    const handoff: IGeneratedPdfHandoff = {
        controller: new AbortController(),
        jobId,
        outputPdfPath,
        reason: null,
        released: Promise.withResolvers(),
    };
    const previous = generatedPdfHandoffs.at(-1);
    generatedPdfHandoffs.push(handoff);
    if (previous) {
        await previous.released.promise;
    }
    if (handoff.reason !== null) {
        return {handoff, outcome: handoff.reason};
    }
    const {signal} = handoff.controller;
    const deadline = setTimeout(() => handoff.controller.abort('timed-out'), GENERATED_PDF_HANDOFF_TIMEOUT_MS);
    let opened = false;
    let error: unknown = undefined;
    try {
        // A handoff with a job is the run finishing now; without one it is
        // the completed journal's replay.
        const open = openGeneratedPdf(outputPdfPath, signal, jobId !== null);
        opened = await new Promise<boolean>((resolve) => {
            const abandon = () => resolve(false);
            signal.addEventListener('abort', abandon, {once: true});
            open.then(
                (answer) => {
                    signal.removeEventListener('abort', abandon);
                    resolve(answer === true);
                },
                (caught: unknown) => {
                    error = caught;
                    signal.removeEventListener('abort', abandon);
                    resolve(false);
                },
            );
            if (signal.aborted) {
                abandon();
            }
        });
    } catch (caught: unknown) {
        error = caught;
        opened = false;
    } finally {
        clearTimeout(deadline);
    }
    return {
        handoff,
        outcome: opened ? 'opened' : signal.aborted ? 'timed-out' : 'open-failed',
        ...(error === undefined ? {} : {error}),
    };
}

/**
 * Ends the handoffs of a coordinator that goes away. A replacement can be
 * installed and replay a terminal state in the same tick, so every job not yet
 * opened goes back to unreported before any abort runs a handler. The stored
 * run stays for the replacement to reconnect.
 */
function disposeGeneratedPdfHandoffs() {
    const handoffs = [...generatedPdfHandoffs];
    for (const handoff of handoffs) {
        if (settleGeneratedPdfHandoff(handoff, 'disposed') === 'disposed' && handoff.jobId !== null) terminalJobs.delete(handoff.jobId);
    }
    for (const handoff of handoffs) {
        if (handoff.reason === 'disposed') handoff.controller.abort('disposed');
        releaseGeneratedPdfHandoff(handoff);
    }
}

function clearScanCleanupRunLivenessTimer() {
    if (runLivenessTimer !== null) {
        clearTimeout(runLivenessTimer);
        runLivenessTimer = null;
    }
    runLivenessGeneration += 1;
}

function isLiveScanCleanupJobState(state: TScanCleanupJobState | null) {
    return state === null || [
        'queued',
        'running',
        'canceling',
        'handoff',
        'committing',
    ].includes(state.status);
}

function isTerminalScanCleanupJobState(state: TScanCleanupJobState | null) {
    return state !== null && [
        'completed',
        'failed',
        'canceled',
    ].includes(state.status);
}

function clearRunGuard() {
    scanCleanupRun.inFlight = false;
    pendingStart = null;
    startRequestPromise = null;
    activeStartResult = null;
    clearScanCleanupRunLivenessTimer();
}

type TScanCleanupRunOwner = Pick<IScanCleanupStartRequest, 'ownerId' | 'documentRevision'>;

/**
 * Releases the guard of a run nothing more will be heard from, unless its
 * terminal state already arrived. `forget` drops the stored job; a page whose
 * channel disconnected keeps it so the page replacing it can reconnect.
 */
function releaseUnobservedScanCleanupRun(jobId: TJobId, forget = true) {
    if (
        scanCleanupRun.activeJobId !== jobId
        || (scanCleanupRun.jobState?.jobId === jobId && isTerminalScanCleanupJobState(scanCleanupRun.jobState))
    ) {
        return false;
    }
    scanCleanupRun.activeJobId = null;
    scanCleanupRun.jobState = null;
    clearRunGuard();
    if (forget) persistActiveJob(null);
    return true;
}

function reportUnobservedScanCleanupRun() {
    if (scanCleanupRun.ownerId) {
        reportScanCleanupRunError(
            scanCleanupRun.ownerId,
            dependencies?.t('scanCleanup.errors.runRecoveryFailed') ?? 'scanCleanup.errors.runRecoveryFailed',
        );
    }
}

async function abandonUnobservedScanCleanupRun(
    capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
    jobId: TJobId,
    owner: TScanCleanupRunOwner,
) {
    if (scanCleanupRun.activeJobId !== jobId) {
        return false;
    }
    await Promise.resolve()
        .then(() => capability.cancel(jobId, owner))
        .catch(() => false);
    return releaseUnobservedScanCleanupRun(jobId);
}

function scheduleScanCleanupRunLivenessCheck() {
    clearScanCleanupRunLivenessTimer();
    if (
        !scanCleanupRun.activeJobId
        || !scanCleanupRun.ownerId
        || !scanCleanupRun.ownerDocumentRevision
        || !isLiveScanCleanupJobState(scanCleanupRun.jobState)
    ) {
        return;
    }

    const jobId = scanCleanupRun.activeJobId;
    const owner = {
        ownerId: scanCleanupRun.ownerId,
        documentRevision: scanCleanupRun.ownerDocumentRevision,
    };
    const generation = runLivenessGeneration;
    runLivenessTimer = setTimeout(() => {
        runLivenessTimer = null;
        void (async () => {
            if (
                generation !== runLivenessGeneration
                || scanCleanupRun.activeJobId !== jobId
                || scanCleanupRun.ownerId !== owner.ownerId
                || scanCleanupRun.ownerDocumentRevision !== owner.documentRevision
            ) {
                return;
            }

            const capability = getScanCleanupCapability();
            if (!capability) {
                scheduleScanCleanupRunLivenessCheck();
                return;
            }

            let state: TScanCleanupJobState | null = null;
            try {
                state = await capability.getJobState(jobId, owner);
            } catch {
                // A transient transport failure is not evidence that the main
                // process forgot the job. Keep the guard and try again.
                if (
                    generation === runLivenessGeneration
                    && scanCleanupRun.activeJobId === jobId
                    && scanCleanupRun.ownerId === owner.ownerId
                    && scanCleanupRun.ownerDocumentRevision === owner.documentRevision
                ) {
                    scheduleScanCleanupRunLivenessCheck();
                }
                return;
            }

            if (
                generation !== runLivenessGeneration
                || scanCleanupRun.activeJobId !== jobId
                || scanCleanupRun.ownerId !== owner.ownerId
                || scanCleanupRun.ownerDocumentRevision !== owner.documentRevision
            ) {
                return;
            }
            if (state) {
                acceptScanCleanupJobState(state);
                return;
            }

            const sourceDocumentRef = scanCleanupRun.ownerDocumentRef;
            const reset = await abandonUnobservedScanCleanupRun(capability, jobId, owner);
            if (reset) {
                reportScanCleanupRunError(
                    owner.ownerId,
                    dependencies?.t('scanCleanup.errors.runRecoveryFailed') ?? 'scanCleanup.errors.runRecoveryFailed',
                    sourceDocumentRef,
                    'internal',
                    owner.documentRevision,
                );
            }
        })();
    }, SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS);
    runLivenessTimer.unref?.();
}

function persistActiveJob(jobId: TJobId | null, documentRef: string | null = scanCleanupRun.ownerDocumentRef) {
    if (!import.meta.client) {
        return;
    }
    if (jobId) {
        sessionStorage.setItem(ACTIVE_JOB_KEY, jobId);
        if (documentRef) {
            sessionStorage.setItem(ACTIVE_JOB_DOCUMENT_KEY, documentRef);
        }
        if (scanCleanupRun.ownerId) sessionStorage.setItem(ACTIVE_JOB_OWNER_KEY, scanCleanupRun.ownerId);
        if (scanCleanupRun.ownerDocumentRevision) sessionStorage.setItem(ACTIVE_JOB_REVISION_KEY, scanCleanupRun.ownerDocumentRevision);
    } else {
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_DOCUMENT_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_OWNER_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_REVISION_KEY);
    }
}

async function handleTerminalState(state: TScanCleanupJobState) {
    const terminalDependencies = dependencies;
    if (!terminalDependencies || terminalJobs.has(state.jobId)) {
        return;
    }
    rememberTerminalJob(state.jobId);

    if (state.status === 'completed') {
        dismissScanCleanupFirstRunGuidanceInStore();
        // The run guard, active job id, and session persistence stay in place
        // until the generated PDF finishes opening: releasing them earlier
        // lets source-document detection and preview restart mid-handoff and
        // race the working-copy claim of the output document.
        const subscription = unsubscribe;
        const {
            handoff,
            outcome,
            error,
        } = await openGeneratedPdfWithHandoff(
            terminalDependencies.openGeneratedPdf,
            state.outputPdfPath,
            state.jobId,
        );
        try {
            const reason = settleGeneratedPdfHandoff(handoff, outcome);
            if (reason === 'disposed') {
                // The renderer that owned this handoff went away. Disposal
                // released its terminal state to the next installation, which
                // may already have replayed it, so this attempt steps aside.
                return;
            }
            scanCleanupRun.activeJobId = null;
            clearRunGuard();
            persistActiveJob(null);
            if (reason !== 'opened') {
                const failure = BrowserLogger.error(
                    'scan-cleanup',
                    'Opening the generated scan cleanup PDF failed',
                    {
                        reason,
                        outputPdfPath: state.outputPdfPath,
                        ...(error === undefined ? {} : {error: getErrorMessage(error)}),
                    },
                    {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'},
                );
                createFailureToastPresenter(terminalDependencies.toast, terminalDependencies.t)({
                    failure,
                    title: terminalDependencies.t('scanCleanup.openResultFailed'),
                    description: state.outputPdfPath,
                });
                return;
            }
            const saveAs = terminalDependencies.createCompletedOutputSaveAs(state.outputPdfPath);
            const completedOutputPath = parseDocumentRef(state.outputPdfPath);
            if (completedOutputPath !== null) {
                await getScanCleanupCapability()?.acknowledgeCompletedOutputs?.([completedOutputPath]).catch(() => undefined);
            }
            // The acknowledgement finishes across disposal; its receipt does
            // not present through a coordinator that is gone.
            if (unsubscribe !== subscription) {
                return;
            }
            const t = terminalDependencies.t;
            const {summary} = state;
            const notices = [
                t('scanCleanup.summary', {
                    input: summary.inputPages,
                    output: summary.outputPages,
                }),
                ...([
                    [
                        'spreads',
                        summary.spreadsSplit,
                    ],
                    [
                        'offcuts',
                        summary.offcutsDiscarded,
                    ],
                    [
                        'blank',
                        summary.blankPagesSkipped,
                    ],
                    [
                        'excluded',
                        summary.excludedPages,
                    ],
                ] as const).filter(([
                    , count,
                ]) => count > 0)
                    .map(([
                        fact,
                        count,
                    ]) => t(`scanCleanup.summaryDetails.${fact}`, {count})),
            ];
            const omission = state.summary.sourceTextOmission;
            if (omission && omission.count > 0) notices.push(t('scanCleanup.sourceTextOmitted', {
                count: omission.count,
                pages: omission.count > omission.pages.length
                    ? t('scanCleanup.sourceTextOmittedMorePages', {
                        pages: omission.pages.join(', '),
                        remaining: omission.count - omission.pages.length,
                    })
                    : omission.pages.join(', '),
            }));
            if (state.summary.accessibilityTagsRemoved) notices.push(t('scanCleanup.accessibilityTagsRemoved'));
            if (state.summary.sourceLayersReconstructed) notices.push(t('scanCleanup.sourceLayersReconstructed'));
            terminalDependencies.toast.add({
                color: state.summary.sourceTextOmission?.count || state.summary.accessibilityTagsRemoved
                    || state.summary.sourceLayersReconstructed ? 'warning' : 'success',
                title: terminalDependencies.t(state.partial
                    ? 'scanCleanup.completedPartialTitle'
                    : 'scanCleanup.completedTitle'),
                description: notices.join(' '),
                actions: [{
                    label: terminalDependencies.t('scanCleanup.saveAs'),
                    color: 'neutral' as const,
                    variant: 'outline' as const,
                    onClick: () => { void saveAs(); },
                }],
            });
            return;
        } finally {
            releaseGeneratedPdfHandoff(handoff);
        }
    }

    scanCleanupRun.activeJobId = null;
    clearRunGuard();
    persistActiveJob(null);

    if (state.status === 'failed') {
        const error = formatScanCleanupErrorByCode(
            {
                t: terminalDependencies.t,
                locale: terminalDependencies.locale(),
            },
            state.errorCode,
            state.error,
            state.scratchShortfall,
        );
        if (scanCleanupRun.ownerId) {
            reportScanCleanupRunError(
                scanCleanupRun.ownerId,
                error,
                scanCleanupRun.ownerDocumentRef,
                state.errorCode,
                scanCleanupRun.ownerDocumentRevision,
                state.failure,
                state.scratchShortfall,
            );
        } else {
            const failure = state.failure ?? BrowserLogger.error(
                'scan-cleanup',
                'Scan cleanup job failed without a workspace owner',
                state.error,
                {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'},
            );
            createFailureToastPresenter(terminalDependencies.toast, terminalDependencies.t)({
                failure,
                title: terminalDependencies.t('scanCleanup.failed'),
                description: error,
                actions: [{
                    label: terminalDependencies.t('scanCleanup.details'),
                    color: 'neutral',
                    variant: 'outline',
                    onClick: requestOwningScanCleanupWorkspace,
                }],
            });
        }
        return;
    }

    if (state.status === 'canceled' && (!scanCleanupRun.ownerId || !scanCleanupRun.workspaceOwnerIds.has(scanCleanupRun.ownerId))) {
        terminalDependencies.toast.add({
            color: 'info',
            title: terminalDependencies.t('scanCleanup.canceled'),
        });
    }
}

function acceptScanCleanupJobState(state: TScanCleanupJobState | TScanCleanupJobClosure) {
    if (isScanCleanupJobClosure(state)) {
        if (releaseUnobservedScanCleanupRun(state.jobId, state.status === 'retired')) reportUnobservedScanCleanupRun();
        return;
    }
    if (scanCleanupRun.activeJobId && state.jobId !== scanCleanupRun.activeJobId) {
        return;
    }
    if (!scanCleanupRun.activeJobId) {
        if (!pendingStart) {
            return;
        }
        scanCleanupRun.activeJobId = state.jobId;
        scanCleanupRun.ownerDocumentRef = pendingStart.sourcePdfPath;
        scanCleanupRun.ownerId = pendingStart.ownerId;
        scanCleanupRun.ownerDocumentRevision = pendingStart.documentRevision;
        persistActiveJob(state.jobId, pendingStart.sourcePdfPath);
    }
    // Replies, streamed events and reconciliation reach this acceptor in any
    // order. A snapshot older than the one shown, or a live one after the
    // terminal state, describes the past, as detection's acceptor rules; a
    // replayed terminal state still reaches a newly installed coordinator.
    const current = scanCleanupRun.jobState;
    if (
        current?.jobId === state.jobId
        && (
            state.updatedAtMs < current.updatedAtMs
            || (isTerminalScanCleanupJobState(current) && !isTerminalScanCleanupJobState(state))
        )
    ) {
        return;
    }
    scanCleanupRun.jobState = state;
    if (isLiveScanCleanupJobState(state)) {
        scheduleScanCleanupRunLivenessCheck();
    } else {
        clearScanCleanupRunLivenessTimer();
    }
    if (isTerminalScanCleanupJobState(state)) {
        void handleTerminalState(state);
    }
}

function requestOwningScanCleanupWorkspace() {
    if (scanCleanupRun.ownerDocumentRef) {
        void dependencies?.openScanCleanupForDocument?.(scanCleanupRun.ownerDocumentRef);
    }
}

async function startScanCleanupRequest(
    capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
    request: IScanCleanupStartRequest,
): Promise<TScanCleanupRendererStartResult> {
    let result: TBridgeScanCleanupStartResult;
    try {
        result = await capability.start(toBridgeSafeScanCleanupPayload({
            ...request,
            options: toPlainScanCleanupOptions(request.options),
        }));
    } catch (error) {
        clearRunGuard();
        throw error;
    }
    if (!result.started) {
        clearRunGuard();
        return result;
    }
    if (terminalJobs.has(result.jobId)) {
        clearRunGuard();
        return result;
    }
    activeStartResult = result;
    scanCleanupRun.activeJobId = result.jobId;
    scanCleanupRun.jobState = null;
    scanCleanupRun.ownerDocumentRef = request.sourcePdfPath;
    scanCleanupRun.ownerId = request.ownerId;
    scanCleanupRun.ownerDocumentRevision = request.documentRevision;
    pendingStart = null;
    persistActiveJob(result.jobId, request.sourcePdfPath);
    const owner = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
    };
    scheduleScanCleanupRunLivenessCheck();
    // The reply is the job's snapshot and null means the job is retired. A
    // rejection means the channel is disconnected: the run keeps its identity
    // and stored job, and the liveness check decides what happened.
    const restored = await Promise.resolve()
        .then(() => capability.subscribeJob(result.jobId, owner))
        .catch(() => undefined);
    if (restored === undefined || scanCleanupRun.activeJobId !== result.jobId) {
        return result;
    }
    if (restored) {
        acceptScanCleanupJobState(restored);
    } else if (await abandonUnobservedScanCleanupRun(capability, result.jobId, owner)) {
        throw new ScanCleanupRunReconciliationError('subscription');
    }
    return result;
}

async function surfacePendingCompletedOutputs(
    capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
) {
    const terminalDependencies = dependencies;
    const subscription = unsubscribe;
    if (!terminalDependencies) {
        return;
    }
    let paths: readonly TDocumentRef[];
    try {
        paths = await capability.getPendingCompletedOutputs?.() ?? [];
    } catch (error) {
        BrowserLogger.warn('scan-cleanup', `Could not read completed output journal: ${getErrorMessage(error)}`);
        return;
    }
    for (const path of paths) {
        if (unsubscribe !== subscription) {
            return;
        }
        const {
            handoff, outcome,
        } = await openGeneratedPdfWithHandoff(
            terminalDependencies.openGeneratedPdf,
            path,
            null,
        );
        try {
            const reason = settleGeneratedPdfHandoff(handoff, outcome);
            if (reason === 'disposed') {
                return;
            }
            // Only an accepted open leaves the journal; a failed or timed-out
            // entry stays for the next replay.
            if (reason === 'opened') {
                await capability.acknowledgeCompletedOutputs?.([path]).catch(error => {
                    BrowserLogger.warn('scan-cleanup', `Could not acknowledge completed output journal: ${getErrorMessage(error)}`);
                });
            }
        } finally {
            releaseGeneratedPdfHandoff(handoff);
        }
    }
}

/**
 * Retires the previous run's state as the click that starts a new attempt is
 * handled. Progress belongs to a job, and the attempt does not have one yet:
 * leaving the last job's terminal snapshot in place is what made a run started
 * after a cancelled one open its meter at the percentage the cancelled run
 * stopped at, and its pages already marked processed.
 */
export function beginScanCleanupAttempt() {
    if (!scanCleanupRun.activeJobId) scanCleanupRun.jobState = null;
}

export function startScanCleanup(request: IScanCleanupStartRequest): Promise<TScanCleanupRendererStartResult> {
    if (scanCleanupRun.inFlight) {
        if (startRequestPromise) {
            return startRequestPromise;
        }
        if (activeStartResult) {
            return Promise.resolve(activeStartResult);
        }
        return Promise.resolve({
            started: false,
            jobId: scanCleanupRun.activeJobId ?? createJobId('scan-cleanup'),
            error: '',
            errorCode: 'internal',
            fallback: 'already-running',
        });
    }
    const capability = getScanCleanupCapability();
    if (!capability) {
        return Promise.resolve({
            started: false,
            jobId: createJobId('scan-cleanup'),
            error: '',
            errorCode: 'tools-unavailable',
            fallback: 'unavailable',
        });
    }
    scanCleanupRun.lastError = null;
    scanCleanupRun.inFlight = true;
    pendingStart = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    };
    startRequestPromise = startScanCleanupRequest(capability, request);
    return startRequestPromise;
}

export type TScanCleanupCancelOutcome = 'accepted' | 'committing' | 'refused';

function resolveScanCleanupCancelOutcome(
    jobId: TJobId,
    state: TScanCleanupJobState | null,
): TScanCleanupCancelOutcome {
    if (!state || state.jobId !== jobId) {
        return 'refused';
    }
    if (scanCleanupRun.activeJobId === jobId) {
        acceptScanCleanupJobState(state);
    }
    if (state.status === 'committing') {
        return 'committing';
    }
    if (state.status === 'canceling' || [
        'completed',
        'failed',
        'canceled',
    ].includes(state.status)) {
        return 'accepted';
    }
    return 'refused';
}

export async function cancelScanCleanup(): Promise<TScanCleanupCancelOutcome> {
    const capability = getScanCleanupCapability();
    const jobId = scanCleanupRun.activeJobId;
    const ownerId = scanCleanupRun.ownerId;
    const documentRevision = scanCleanupRun.ownerDocumentRevision;
    if (!capability || !jobId || !ownerId || !documentRevision) {
        return 'refused';
    }
    const owner = {
        ownerId,
        documentRevision,
    };
    const cancelAccepted = await Promise.resolve()
        .then(() => capability.cancel(jobId, owner))
        .catch(() => false);
    if (cancelAccepted) {
        return 'accepted';
    }

    // The boolean cancel IPC predates the public committing state. Read the
    // authoritative record when the registry refuses or the bridge rejects a
    // request so the renderer can explain the commit-window outcome instead
    // of treating it as a silent no-op.
    const authoritativeState = await capability.getJobState(jobId, owner).catch(() => null);
    const state = authoritativeState
        ?? (scanCleanupRun.jobState?.jobId === jobId ? scanCleanupRun.jobState : null);
    return resolveScanCleanupCancelOutcome(jobId, state);
}

/**
 * Registers a cleanup workspace's visibility, read whenever a toast asks. The
 * returned disposer removes only this registration, not a later one of the
 * same owner.
 */
export function registerScanCleanupWorkspaceOwner(ownerId: string, visible: () => boolean) {
    const registration = () => visible();
    workspaceOwners.set(ownerId, registration);
    return () => {
        if (workspaceOwners.get(ownerId) === registration) workspaceOwners.delete(ownerId);
    };
}

export async function pruneScanCleanupOutputs() {
    const capability = getScanCleanupCapability();
    return capability && dependencies
        ? capability.pruneGeneratedOutputs()
        : 0;
}

export function installScanCleanupRunCoordinator(nextDependencies: IScanCleanupCoordinatorDependencies) {
    const installation: IScanCleanupCoordinatorInstallation = {
        dependencies: nextDependencies,
        active: true,
    };
    installations.push(installation);
    dependencies = nextDependencies;

    const dispose = () => {
        if (!installation.active) {
            return;
        }
        installation.active = false;
        const index = installations.indexOf(installation);
        if (index >= 0) installations.splice(index, 1);
        const latest = installations.at(-1);
        if (latest) {
            dependencies = latest.dependencies;
            return;
        }
        unsubscribe?.();
        unsubscribe = null;
        dependencies = null;
        clearScanCleanupRunLivenessTimer();
        disposeGeneratedPdfHandoffs();
    };

    if (unsubscribe) {
        return dispose;
    }
    const capability = getScanCleanupCapability();
    if (!capability) {
        return dispose;
    }
    const stopListening = capability.onJobState(acceptScanCleanupJobState);
    // A closure of its own, so a replacement subscription never looks like this one.
    const subscription = () => stopListening();
    unsubscribe = subscription;
    const storedJobId = parseJobId(import.meta.client ? sessionStorage.getItem(ACTIVE_JOB_KEY) : null);
    if (storedJobId) {
        scanCleanupRun.activeJobId = storedJobId;
        scanCleanupRun.inFlight = true;
        scanCleanupRun.ownerDocumentRef = sessionStorage.getItem(ACTIVE_JOB_DOCUMENT_KEY);
        scanCleanupRun.ownerId = sessionStorage.getItem(ACTIVE_JOB_OWNER_KEY);
        scanCleanupRun.ownerDocumentRevision = sessionStorage.getItem(ACTIVE_JOB_REVISION_KEY);
        if (!scanCleanupRun.ownerId || !scanCleanupRun.ownerDocumentRevision) {
            scanCleanupRun.activeJobId = null;
            clearRunGuard();
            persistActiveJob(null);
            void surfacePendingCompletedOutputs(capability);
        } else {
            const owner = {
                ownerId: scanCleanupRun.ownerId,
                documentRevision: scanCleanupRun.ownerDocumentRevision,
            };
            scheduleScanCleanupRunLivenessCheck();
            void (async () => {
                // The reconnect reply is the snapshot. A retired job leaves
                // only the completed-output journal; a disconnected one is
                // kept for the liveness check.
                const state = await Promise.resolve()
                    .then(() => capability.reconnectJob(storedJobId, owner))
                    .catch(() => undefined);
                if (state === undefined || unsubscribe !== subscription || scanCleanupRun.activeJobId !== storedJobId) {
                    return;
                }
                if (state) acceptScanCleanupJobState(state);
                else {
                    if (await abandonUnobservedScanCleanupRun(capability, storedJobId, owner)) reportUnobservedScanCleanupRun();
                    void surfacePendingCompletedOutputs(capability);
                }
            })();
        }
    } else {
        void surfacePendingCompletedOutputs(capability);
    }
    return dispose;
}
