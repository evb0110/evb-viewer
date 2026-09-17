import { getErrorMessage } from '@app/utils/error';
import type {
    IScanCleanupStartRequest,
    TScanCleanupStartResult as TBridgeScanCleanupStartResult,
    TScanCleanupJobState,
    TScanCleanupErrorCode,
} from '@contracts/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    createJobId,
    parseJobId,
    type TJobId,
} from '@contracts/shared';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createFailureToastPresenter} from '@app/composables/useFailureToast';
import {formatScanCleanupErrorMessage} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {dismissScanCleanupFirstRunGuidanceInStore} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const ACTIVE_JOB_KEY = 'evb.scanCleanup.activeJobId';
const ACTIVE_JOB_DOCUMENT_KEY = 'evb.scanCleanup.activeDocumentRef';
const ACTIVE_JOB_OWNER_KEY = 'evb.scanCleanup.activeOwnerId';
const ACTIVE_JOB_REVISION_KEY = 'evb.scanCleanup.activeDocumentRevision';
const RUN_SUBSCRIPTION_RECONCILIATION_ATTEMPTS = 3;
/**
 * How long the coordinator keeps the completed run's guard, active job id, and
 * session persistence alive while the generated PDF is handed to the workspace.
 * Kept at the bounded document-open stage budget the workspace controller uses,
 * so a handoff that never answers fails the run instead of pinning it forever.
 */
const GENERATED_PDF_HANDOFF_TIMEOUT_MS = 30_000;

export type TScanCleanupRunReconciliationFailure = 'subscription' | 'recovery';

export type TScanCleanupStartFallback = 'already-running' | 'unavailable';

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
    failure?: FailureReceipt;
}

export const scanCleanupRun = reactive({
    activeJobId: null as TJobId | null,
    inFlight: false,
    workspaceOwnerIds: new Set<string>(),
    jobState: null as TScanCleanupJobState | null,
    lastError: null as IScanCleanupRunError | null,
    ownerDocumentRef: null as string | null,
    ownerDocumentRevision: null as string | null,
    ownerId: null as string | null,
});

export const isScanCleanupRunning = computed(() => Boolean(
    scanCleanupRun.inFlight
    || (
        scanCleanupRun.activeJobId
        && scanCleanupRun.jobState
        && [
            'queued',
            'running',
            'canceling',
            'handoff',
        ].includes(scanCleanupRun.jobState.status)
    ),
));

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
) {
    scanCleanupRun.lastError = error ? {
        documentRevision,
        error,
        errorCode,
        ownerId,
        sourceDocumentRef,
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
) {
    const failure = existingFailure ?? BrowserLogger.error(
        'scan-cleanup',
        'Scan cleanup run failed',
        error,
        {
            code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
            context: {},
        },
    );
    setScanCleanupRunError(
        ownerId,
        error,
        errorCode,
        sourceDocumentRef,
        sourceDocumentRevision,
        failure,
    );
    if (!dependencies) {
        return;
    }
    const workspaceIsOpen = scanCleanupRun.workspaceOwnerIds.has(ownerId);
    createFailureToastPresenter(dependencies.toast)({
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
        || ![
            'queued',
            'running',
            'handoff',
        ].includes(state.status)
    ) {
        return new Set();
    }
    if (state.progress.completedPageNumbersTruncated === true) {
        const completedPageCount = Math.max(
            0,
            Math.min(totalPages, state.progress.completedUnits),
        );
        return new Set(Array.from(
            {length: completedPageCount},
            (_, index) => index + 1,
        ));
    }
    return new Set((state.progress.completedPageNumbers ?? [])
        .filter(pageNumber => pageNumber <= totalPages));
}

interface IScanCleanupToast {add: (options: {
    color?: 'error' | 'info' | 'success';
    title: string;
    description?: string;
    actions?: Array<{
        label: string;
        color?: 'neutral' | 'primary';
        variant?: 'outline' | 'soft';
        onClick: () => void;
    }>;
}) => unknown;}

export interface IScanCleanupCoordinatorDependencies {
    openGeneratedPdf: (path: string, signal: AbortSignal) => Promise<boolean>;
    saveActiveDocumentAs: () => Promise<unknown>;
    openScanCleanupForDocument?: (documentRef: string) => Promise<boolean> | boolean;
    t: TTranslateFn;
    toast: IScanCleanupToast;
}

let installed = false;
let unsubscribe: (() => void) | null = null;
let dependencies: IScanCleanupCoordinatorDependencies | null = null;
let pendingStart: Pick<IScanCleanupStartRequest, 'documentRevision' | 'ownerId' | 'sourcePdfPath'> | null = null;
let startRequestPromise: Promise<TScanCleanupRendererStartResult> | null = null;
let activeStartResult: Extract<TBridgeScanCleanupStartResult, {started: true}> | null = null;

interface IGeneratedPdfHandoff {
    controller: AbortController;
    generation: number;
    invalidated: boolean;
    jobId: TJobId;
}

let handoffGeneration = 0;
let activeGeneratedPdfHandoff: IGeneratedPdfHandoff | null = null;

/**
 * Resolves as soon as the open answers or the handoff deadline fires, and keeps
 * consuming the open promise afterwards so a late answer can neither reject
 * unhandled nor settle this handoff a second time.
 */
function settleGeneratedPdfHandoff(open: Promise<boolean>, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
        const abandon = () => resolve(false);
        signal.addEventListener('abort', abandon, {once: true});
        open.then(
            (opened) => {
                signal.removeEventListener('abort', abandon);
                resolve(opened === true);
            },
            () => {
                signal.removeEventListener('abort', abandon);
                resolve(false);
            },
        );
        if (signal.aborted) {
            abandon();
        }
    });
}

function invalidateGeneratedPdfHandoff() {
    const handoff = activeGeneratedPdfHandoff;
    if (!handoff) {
        return;
    }
    handoff.invalidated = true;
    activeGeneratedPdfHandoff = null;
    handoffGeneration += 1;
    // The job goes back to unreported before the abort is visible anywhere. A
    // replacement coordinator can be installed and replayed synchronously in
    // the same tick as disposal, and the abandoned handler only resumes a
    // microtask later: releasing the reservation there would arrive after the
    // replay it is meant to admit.
    terminalJobs.delete(handoff.jobId);
    handoff.controller.abort(new Error('Scan cleanup coordinator was disposed'));
}

function clearRunGuard() {
    scanCleanupRun.inFlight = false;
    pendingStart = null;
    startRequestPromise = null;
    activeStartResult = null;
}

function yieldToRunReconciliation() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

type TScanCleanupRunOwner = Pick<IScanCleanupStartRequest, 'ownerId' | 'documentRevision'>;

async function reconcileScanCleanupRunState(
    capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
    jobId: TJobId,
    owner: TScanCleanupRunOwner,
) {
    for (let attempt = 0; attempt < RUN_SUBSCRIPTION_RECONCILIATION_ATTEMPTS; attempt += 1) {
        const state = await Promise.resolve()
            .then(() => capability.getJobState(jobId, owner))
            .catch(() => null);
        const reconnected = await Promise.resolve()
            .then(() => capability.reconnectJob(jobId, owner))
            .catch(() => null);
        if (reconnected) {
            return reconnected;
        }
        if (state) {
            return state;
        }
        if (attempt + 1 < RUN_SUBSCRIPTION_RECONCILIATION_ATTEMPTS) {
            await yieldToRunReconciliation();
        }
    }
    return null;
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
    if (scanCleanupRun.activeJobId !== jobId) {
        return false;
    }
    scanCleanupRun.activeJobId = null;
    scanCleanupRun.jobState = null;
    clearRunGuard();
    persistActiveJob(null);
    return true;
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

function summaryText(state: Extract<TScanCleanupJobState, {status: 'completed'}>) {
    return dependencies?.t('scanCleanup.summary', {
        input: state.summary.inputPages,
        output: state.summary.outputPages,
        spreads: state.summary.spreadsSplit,
        offcuts: state.summary.offcutsDiscarded,
    }) ?? '';
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
        handoffGeneration += 1;
        const handoff: IGeneratedPdfHandoff = {
            controller: new AbortController(),
            generation: handoffGeneration,
            invalidated: false,
            jobId: state.jobId,
        };
        activeGeneratedPdfHandoff = handoff;
        const deadline = setTimeout(
            () => handoff.controller.abort(new Error('Generated PDF handoff timed out')),
            GENERATED_PDF_HANDOFF_TIMEOUT_MS,
        );
        let opened = false;
        try {
            opened = await settleGeneratedPdfHandoff(
                terminalDependencies.openGeneratedPdf(state.outputPdfPath, handoff.controller.signal),
                handoff.controller.signal,
            );
        } catch {
            opened = false;
        } finally {
            clearTimeout(deadline);
            if (activeGeneratedPdfHandoff === handoff) {
                activeGeneratedPdfHandoff = null;
            }
        }
        if (handoff.invalidated) {
            // The renderer that owned this handoff went away. Its terminal
            // state was released back to the next coordinator installation as
            // the handoff was invalidated, and a replay may already have been
            // accepted since, so this abandoned attempt only steps aside.
            return;
        }
        if (handoff.generation !== handoffGeneration) {
            return;
        }
        scanCleanupRun.activeJobId = null;
        clearRunGuard();
        persistActiveJob(null);
        if (!opened) {
            const failure = BrowserLogger.error(
                'scan-cleanup',
                'Opening the generated scan cleanup PDF failed',
                undefined,
                {
                    code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
                    context: {},
                },
            );
            createFailureToastPresenter(terminalDependencies.toast)({
                failure,
                title: terminalDependencies.t('scanCleanup.openResultFailed'),
                description: state.outputPdfPath,
            });
            return;
        }
        terminalDependencies.toast.add({
            color: 'success',
            title: terminalDependencies.t(state.partial
                ? 'scanCleanup.completedPartialTitle'
                : 'scanCleanup.completedTitle'),
            description: summaryText(state),
            actions: [{
                label: terminalDependencies.t('scanCleanup.saveAs'),
                color: 'neutral' as const,
                variant: 'outline' as const,
                onClick: () => { void dependencies?.saveActiveDocumentAs(); },
            }],
        });
        return;
    }

    scanCleanupRun.activeJobId = null;
    clearRunGuard();
    persistActiveJob(null);

    if (state.status === 'failed') {
        const error = formatScanCleanupErrorMessage(
            terminalDependencies.t('scanCleanup.failed'),
            state.error,
        );
        if (scanCleanupRun.ownerId) {
            reportScanCleanupRunError(
                scanCleanupRun.ownerId,
                error,
                scanCleanupRun.ownerDocumentRef,
                state.errorCode,
                scanCleanupRun.ownerDocumentRevision,
                state.failure,
            );
        } else {
            const failure = state.failure ?? BrowserLogger.error(
                'scan-cleanup',
                'Scan cleanup job failed without a workspace owner',
                state.error,
                {
                    code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
                    context: {},
                },
            );
            createFailureToastPresenter(terminalDependencies.toast)({
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

function acceptScanCleanupJobState(state: TScanCleanupJobState) {
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
    scanCleanupRun.jobState = state;
    if ([
        'completed',
        'failed',
        'canceled',
    ].includes(state.status)) {
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
    scanCleanupRun.ownerDocumentRef = request.sourcePdfPath;
    scanCleanupRun.ownerId = request.ownerId;
    scanCleanupRun.ownerDocumentRevision = request.documentRevision;
    pendingStart = null;
    persistActiveJob(result.jobId, request.sourcePdfPath);
    const owner = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
    };
    let restored: TScanCleanupJobState | null;
    try {
        restored = await capability.subscribeJob(result.jobId, owner);
    } catch (caught) {
        if (scanCleanupRun.activeJobId !== result.jobId) {
            return result;
        }
        const reconciled = await reconcileScanCleanupRunState(capability, result.jobId, owner);
        if (scanCleanupRun.activeJobId !== result.jobId) {
            return result;
        }
        if (reconciled) {
            acceptScanCleanupJobState(reconciled);
            return result;
        }
        const reset = await abandonUnobservedScanCleanupRun(capability, result.jobId, owner);
        if (reset) {
            throw new ScanCleanupRunReconciliationError(
                'subscription',
                caught instanceof Error ? getErrorMessage(caught) : '',
            );
        }
        return result;
    }
    if (restored) acceptScanCleanupJobState(restored);
    return result;
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

export async function cancelScanCleanup() {
    const capability = getScanCleanupCapability();
    return Boolean(capability && scanCleanupRun.activeJobId
        && scanCleanupRun.ownerId
        && scanCleanupRun.ownerDocumentRevision
        && await capability.cancel(scanCleanupRun.activeJobId, {
            ownerId: scanCleanupRun.ownerId,
            documentRevision: scanCleanupRun.ownerDocumentRevision,
        }));
}

export function setScanCleanupWorkspaceOwnerOpen(ownerId: string, open: boolean) {
    if (open) scanCleanupRun.workspaceOwnerIds.add(ownerId);
    else scanCleanupRun.workspaceOwnerIds.delete(ownerId);
}

export async function pruneScanCleanupOutputs() {
    const capability = getScanCleanupCapability();
    return capability && dependencies
        ? capability.pruneGeneratedOutputs()
        : 0;
}

export function installScanCleanupRunCoordinator(nextDependencies: IScanCleanupCoordinatorDependencies) {
    dependencies = nextDependencies;
    if (installed) {
        return () => undefined;
    }
    const capability = getScanCleanupCapability();
    if (!capability) {
        return () => undefined;
    }
    installed = true;
    unsubscribe = capability.onJobState(acceptScanCleanupJobState);
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
        } else {
            const owner = {
                ownerId: scanCleanupRun.ownerId,
                documentRevision: scanCleanupRun.ownerDocumentRevision,
            };
            void (async () => {
                const state = await reconcileScanCleanupRunState(capability, storedJobId, owner);
                if (state) acceptScanCleanupJobState(state);
                else if (scanCleanupRun.activeJobId === storedJobId) {
                    const ownerId = scanCleanupRun.ownerId;
                    const sourceDocumentRef = scanCleanupRun.ownerDocumentRef;
                    const reset = await abandonUnobservedScanCleanupRun(capability, storedJobId, owner);
                    if (reset && ownerId) {
                        reportScanCleanupRunError(
                            ownerId,
                            nextDependencies.t('scanCleanup.errors.runRecoveryFailed'),
                            sourceDocumentRef,
                            'internal',
                        );
                    }
                }
            })();
        }
    }
    return () => {
        unsubscribe?.();
        unsubscribe = null;
        installed = false;
        dependencies = null;
        invalidateGeneratedPdfHandoff();
    };
}
