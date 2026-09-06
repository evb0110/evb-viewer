import type {
    IPdfDocument,
    IPdfPage,
    IPdfRenderTask,
    IPdfDocumentPageLease,
    TPdfDocumentPageLeaseRetention,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    runCoordinatedPdfPageRender,
    type TPdfPageOperationSettlementCapture,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import type { TPdfRenderContinuationPriority } from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
    type IPdfRenderSupervisorTimer,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import {
    workspaceSurfaceBudgetController,
    type IWorkspaceSurfaceBudgetController,
    type IWorkspaceSurfaceLease,
} from '@app/utils/document-viewer/workspaceSurfaceBudget';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

export type TPdfRasterLane =
    | 'navigation-target'
    | 'viewport-visible'
    | 'viewport-nearby'
    | 'thumbnail-current'
    | 'thumbnail-visible'
    | 'prefetch';

export interface IPdfRasterDocumentFence {
    readonly loadToken: number;
    readonly documentVersion: number;
    readonly documentRevision: string | null;
}

export interface IPdfRasterDemand {
    readonly pageNumber: number;
    readonly renderKey: string;
    readonly lane: TPdfRasterLane;
    readonly ordinal: number;
    readonly estimatedPixels: number;
    readonly retention: TPdfDocumentPageLeaseRetention;
    readonly documentFence: IPdfRasterDocumentFence;
    readonly consumerGeneration: number;
}

export interface IPdfRasterDemandPolicy<TInput> {
    expand(input: TInput): readonly IPdfRasterDemand[];
    compareWithinLane(left: IPdfRasterDemand, right: IPdfRasterDemand): number;
}

export interface IPdfRasterRenderTarget<TPrepared> {
    readonly id: string;
    prepare(
        demand: IPdfRasterDemand,
        page: IPdfPage,
        signal: AbortSignal,
        captureSettlement: TPdfPageOperationSettlementCapture,
    ): Promise<TPrepared | null>;
    start(prepared: TPrepared, page: IPdfPage): IPdfRenderTask;
    commit(prepared: TPrepared, demand: IPdfRasterDemand): boolean;
    discard(prepared: TPrepared): void;
    onRenderStall?: ((payload: IPageRenderStallPayload) => void) | undefined;
    release(pageNumber: number, reason: string): void;
}

export type TPdfRasterOutcome =
    | {
        readonly status: 'committed';
        readonly demand: IPdfRasterDemand;
    }
    | {
        readonly status: 'cancelled' | 'discarded';
        readonly demand: IPdfRasterDemand;
    }
    | {
        readonly status: 'failed';
        readonly demand: IPdfRasterDemand;
        readonly error: unknown;
    };

export interface IPdfRasterInvalidation {
    readonly reason: string;
    readonly documentFence?: IPdfRasterDocumentFence | undefined;
    readonly pages?: readonly number[] | undefined;
    readonly sourceId?: string | undefined;
}

export interface IPdfRasterSchedulerSnapshot {
    readonly accepting: boolean;
    readonly queueDepth: number;
    readonly queuedByLane: Readonly<Record<TPdfRasterLane, number>>;
    readonly inFlightByLane: Readonly<Record<TPdfRasterLane, number>>;
    readonly inFlightPages: ReadonlyArray<{
        readonly lane: TPdfRasterLane;
        readonly pageNumber: number;
        readonly sourceId: string;
        readonly targetId: string;
    }>;
    readonly residentPages: ReadonlyArray<{
        readonly lane: TPdfRasterLane;
        readonly pageNumber: number;
        readonly sourceId: string;
        readonly targetId: string;
    }>;
    readonly reservedPixels: number;
}

export interface IPdfPageRasterScheduler {
    readonly documentFence: IPdfRasterDocumentFence;
    setDemand<TInput, TPrepared>(request: {
        sourceId: string;
        input: TInput;
        policy: IPdfRasterDemandPolicy<TInput>;
        target: IPdfRasterRenderTarget<TPrepared>;
    }): void;
    request<TPrepared>(request: {
        sourceId: string;
        demand: IPdfRasterDemand;
        target: IPdfRasterRenderTarget<TPrepared>;
    }): Promise<TPdfRasterOutcome>;
    invalidate(scope: IPdfRasterInvalidation): void;
    cancelSource(sourceId: string): Promise<void>;
    snapshot(): IPdfRasterSchedulerSnapshot;
    dispose(): Promise<void>;
}

interface ICreatePdfPageRasterSchedulerOptions {
    documentFence: IPdfRasterDocumentFence;
    leasePage: (
        pageNumber: number,
        retention?: TPdfDocumentPageLeaseRetention,
    ) => Promise<IPdfDocumentPageLease>;
    maxConcurrency?: number | undefined;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    surfaceBudget?: IWorkspaceSurfaceBudgetController | undefined;
}

interface IRasterWork<TPrepared = unknown> {
    controller: AbortController;
    coordinatedOperationSettlements: Set<Promise<void>>;
    demand: IPdfRasterDemand;
    execution: Promise<void> | null;
    key: string;
    oneShot: boolean;
    pageLease: IPdfDocumentPageLease | null;
    policyCompare: (left: IPdfRasterDemand, right: IPdfRasterDemand) => number;
    prepared: TPrepared | null;
    reservation: IWorkspaceSurfaceLease | null;
    resolve: ((outcome: TPdfRasterOutcome) => void) | null;
    retryCount: number;
    retryTimer: IPdfRenderSupervisorTimer | null;
    targetReleased: boolean;
    sequence: number;
    sourceId: string;
    stage: 'queued' | 'leased' | 'preparing' | 'rendering' | 'committing';
    target: IPdfRasterRenderTarget<TPrepared>;
}

interface IResidentRaster {
    demand: IPdfRasterDemand;
    key: string;
    reservation: IWorkspaceSurfaceLease;
    sourceId: string;
    target: IPdfRasterRenderTarget<unknown>;
}

const LANE_ORDER: Record<TPdfRasterLane, number> = {
    'navigation-target': 600,
    'viewport-visible': 500,
    'viewport-nearby': 300,
    'thumbnail-current': 200,
    'thumbnail-visible': 200,
    'prefetch': 100,
};
const LANE_CONTINUATION_PRIORITY: Record<TPdfRasterLane, TPdfRenderContinuationPriority> = {
    'navigation-target': 'navigation-target',
    'viewport-visible': 'visible',
    'viewport-nearby': 'nearby',
    'thumbnail-current': 'thumbnail',
    'thumbnail-visible': 'thumbnail',
    'prefetch': 'prefetch',
};
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 16;
let nextSchedulerScopeId = 0;

function createLaneCounts() {
    return {
        'navigation-target': 0,
        'viewport-visible': 0,
        'viewport-nearby': 0,
        'thumbnail-current': 0,
        'thumbnail-visible': 0,
        'prefetch': 0,
    } satisfies Record<TPdfRasterLane, number>;
}

function isSameDocumentFence(
    left: IPdfRasterDocumentFence,
    right: IPdfRasterDocumentFence,
) {
    return left.loadToken === right.loadToken
        && left.documentVersion === right.documentVersion
        && left.documentRevision === right.documentRevision;
}

function createWorkKey(targetId: string, demand: IPdfRasterDemand) {
    return `${targetId}\0${String(demand.pageNumber)}\0${demand.renderKey}`;
}

function createDemandIdentity(sourceId: string, targetId: string, pageNumber: number) {
    return `${sourceId}\0${targetId}\0${String(pageNumber)}`;
}

export function createPdfPageRasterScheduler(
    options: ICreatePdfPageRasterSchedulerOptions,
): IPdfPageRasterScheduler {
    const maxConcurrency = Math.max(1, Math.trunc(options.maxConcurrency ?? 2));
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const surfaceBudget = options.surfaceBudget ?? workspaceSurfaceBudgetController;
    const surfaceScopeId = `pdf-raster-scheduler:${++nextSchedulerScopeId}`;
    const queued = new Map<string, IRasterWork>();
    const inFlight = new Map<string, IRasterWork>();
    const retryPending = new Map<string, IRasterWork>();
    const residents = new Map<string, IResidentRaster>();
    const demandKeysBySource = new Map<string, Set<string>>();
    const currentDemandByIdentity = new Map<string, IPdfRasterDemand>();
    let accepting = true;
    let disposal: Promise<void> | null = null;
    let nextSequence = 0;
    let pumpScheduled = false;

    function getIndexedWork(key: string) {
        return queued.get(key) ?? inFlight.get(key) ?? retryPending.get(key);
    }

    function isDemandCurrent(work: IRasterWork) {
        if (
            !accepting
            || work.controller.signal.aborted
            || !isSameDocumentFence(work.demand.documentFence, options.documentFence)
        ) {
            return false;
        }
        if (work.oneShot) {
            return true;
        }
        const identity = createDemandIdentity(
            work.sourceId,
            work.target.id,
            work.demand.pageNumber,
        );
        const current = currentDemandByIdentity.get(identity);
        return current?.renderKey === work.demand.renderKey
            && current.consumerGeneration === work.demand.consumerGeneration
            && demandKeysBySource.get(work.sourceId)?.has(work.key) === true;
    }

    function releaseReservation(work: IRasterWork) {
        work.reservation?.release();
        work.reservation = null;
    }

    function captureWorkSettlement(work: IRasterWork, settlement: Promise<void>) {
        work.coordinatedOperationSettlements.add(settlement);
        void settlement.then(() => work.coordinatedOperationSettlements.delete(settlement));
    }

    async function releasePageLease(work: IRasterWork) {
        const pageLease = work.pageLease;
        if (!pageLease) {
            return;
        }
        if (work.coordinatedOperationSettlements.size > 0) {
            await Promise.allSettled(work.coordinatedOperationSettlements);
        }
        pageLease.release();
        work.pageLease = null;
    }

    function hasPendingWorkForPage(targetId: string, pageNumber: number) {
        const prefix = `${targetId}\0${String(pageNumber)}\0`;
        for (const key of queued.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        for (const key of inFlight.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        for (const key of retryPending.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    function hasCommittedResidentForPage(targetId: string, pageNumber: number) {
        const prefix = `${targetId}\0${String(pageNumber)}\0`;
        for (const key of residents.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    function releaseTarget(work: IRasterWork, reason: string) {
        if (work.targetReleased) {
            return;
        }
        work.targetReleased = true;
        // A committed raster for this page (any render key) remains the
        // correct visual until its replacement commits; releasing the target
        // here would blank a visible page mid-resize. The resident's own
        // release path clears the page when it is truly evicted or replaced.
        if (hasCommittedResidentForPage(work.target.id, work.demand.pageNumber)) {
            return;
        }
        work.target.release(work.demand.pageNumber, reason);
    }

    function discardPrepared(work: IRasterWork) {
        if (work.prepared === null) {
            return;
        }
        work.target.discard(work.prepared);
        work.prepared = null;
    }

    function settleWork(work: IRasterWork, outcome: TPdfRasterOutcome) {
        work.retryTimer?.clear();
        work.retryTimer = null;
        if (retryPending.get(work.key) === work) {
            retryPending.delete(work.key);
        }
        work.resolve?.(outcome);
        work.resolve = null;
    }

    function cancelWork(work: IRasterWork, reason: string) {
        work.retryTimer?.clear();
        work.retryTimer = null;
        work.controller.abort();
        if (work.stage !== 'rendering') {
            releaseReservation(work);
        }
        queued.delete(work.key);
        settleWork(work, {
            status: 'cancelled',
            demand: work.demand,
        });
        if (work.prepared !== null && work.stage !== 'rendering') {
            discardPrepared(work);
        }
        if (work.stage !== 'rendering' && work.stage !== 'committing') {
            releaseTarget(work, reason);
        }
    }

    function releaseResident(resident: IResidentRaster, reason: string) {
        if (residents.get(resident.key) === resident) {
            residents.delete(resident.key);
        }
        resident.reservation.release();
        resident.target.release(resident.demand.pageNumber, reason);
    }

    function compareWork(left: IRasterWork, right: IRasterWork) {
        return LANE_ORDER[right.demand.lane] - LANE_ORDER[left.demand.lane]
            || (
                left.demand.lane === right.demand.lane
                    ? left.policyCompare(left.demand, right.demand)
                    : 0
            )
            || left.demand.ordinal - right.demand.ordinal
            || left.sequence - right.sequence;
    }

    // Only the minimum is needed, and the queue can change between dequeues
    // within one pump, so this scans live entries instead of snapshotting and
    // sorting the whole queue. `compareWork` remains the only ordering source.
    function takeNextWork() {
        let next: IRasterWork | null = null;
        for (const work of queued.values()) {
            if (next === null || compareWork(work, next) < 0) {
                next = work;
            }
        }
        if (next) {
            queued.delete(next.key);
        }
        return next;
    }

    function schedulePump() {
        if (pumpScheduled || !accepting) {
            return;
        }
        pumpScheduled = true;
        queueMicrotask(() => {
            pumpScheduled = false;
            pump();
        });
    }

    // An attempt that ends without a resident raster while its demand is still
    // current leaves the surface blank with nothing left to redraw it: settled work
    // is in neither `residents` nor `queued`, so only a fresh setDemand would
    // re-enqueue it, and a settled viewport or thumbnail pane has no reason to
    // republish. Every such ending — a thrown render, a target that declines to
    // prepare, a target that rejects the commit — reattempts here, so the
    // scheduler's own contract does not depend on an external nudge.
    function armPendingReattempt(work: IRasterWork) {
        if (
            retryPending.get(work.key) !== work
            || work.retryTimer !== null
            || inFlight.get(work.key) === work
        ) {
            return;
        }
        const retryTimer = renderSupervisor.armTimer({
            cause: 'render-cancelled-retry',
            // Backed off, because the conditions a target declines on — a canvas
            // swapped by a re-render, a debounced remeasure, a resize settling —
            // outlast a single frame. Flat retries would spend the whole budget
            // inside one layout pass and observe the same transient state thrice.
            delayMs: RETRY_DELAY_MS * 2 ** (work.retryCount - 1),
            key: `raster-scheduler:${surfaceScopeId}:${work.key}`,
            metadata: {
                lane: work.demand.lane,
                pageNumber: work.demand.pageNumber,
                retryCount: work.retryCount,
                sourceId: work.sourceId,
                targetId: work.target.id,
            },
            onFire: () => {
                if (retryPending.get(work.key) !== work) {
                    return;
                }
                retryPending.delete(work.key);
                work.retryTimer = null;
                if (!isDemandCurrent(work)) {
                    settleWork(work, {
                        status: 'cancelled',
                        demand: work.demand,
                    });
                    return;
                }
                queued.set(work.key, work);
                schedulePump();
            },
        });
        if (retryPending.get(work.key) === work) {
            work.retryTimer = retryTimer;
        } else {
            retryTimer.clear();
        }
    }

    function scheduleReattempt(work: IRasterWork, exhausted: TPdfRasterOutcome) {
        if (!isDemandCurrent(work) || work.retryCount >= MAX_RETRIES) {
            settleWork(work, exhausted);
            return;
        }
        work.retryCount += 1;
        work.stage = 'queued';
        retryPending.set(work.key, work);
    }

    async function executeWork(work: IRasterWork) {
        let committed = false;
        try {
            if (!isDemandCurrent(work)) {
                settleWork(work, {
                    status: 'cancelled',
                    demand: work.demand,
                });
                return;
            }
            work.stage = 'leased';
            work.pageLease = await options.leasePage(
                work.demand.pageNumber,
                work.demand.retention,
            );
            if (!isDemandCurrent(work)) {
                settleWork(work, {
                    status: 'cancelled',
                    demand: work.demand,
                });
                return;
            }
            const category = work.demand.lane.startsWith('thumbnail')
                ? 'pdf-thumbnail-canvas'
                : 'pdf-page-canvas';
            const reservationRequest: Parameters<typeof surfaceBudget.reserve>[0] = {
                scopeId: surfaceScopeId,
                category,
                bytes: Math.max(1, Math.ceil(work.demand.estimatedPixels)) * 4,
                priority: LANE_ORDER[work.demand.lane],
                // A resident whose own replacement is queued or in flight
                // refuses eviction: evicting it would blank a visible page
                // for the gap before its replacement commits. Budget pressure
                // falls on genuinely cold residents instead.
                canEvict: () => residents.has(work.key)
                    && !hasPendingWorkForPage(work.target.id, work.demand.pageNumber)
                    && !(isDemandCurrent(work) && (
                        work.demand.lane === 'navigation-target'
                        || work.demand.lane === 'viewport-visible'
                    )),
                evict: () => {
                    const resident = residents.get(work.key);
                    if (resident) {
                        releaseResident(resident, 'surface-budget-eviction');
                    }
                },
            };
            work.reservation = work.demand.lane === 'navigation-target'
                || work.demand.lane === 'viewport-visible'
                ? surfaceBudget.reserve(reservationRequest)
                : surfaceBudget.tryReserve(reservationRequest);
            if (!work.reservation) {
                throw new Error(`PDF raster surface budget unavailable for page ${String(work.demand.pageNumber)}`);
            }
            work.stage = 'preparing';
            work.prepared = await work.target.prepare(
                work.demand,
                work.pageLease.page,
                work.controller.signal,
                settlement => captureWorkSettlement(work, settlement),
            );
            if (!work.prepared) {
                releaseReservation(work);
                scheduleReattempt(work, {
                    status: 'discarded',
                    demand: work.demand,
                });
                return;
            }
            if (!isDemandCurrent(work)) {
                discardPrepared(work);
                releaseReservation(work);
                settleWork(work, {
                    status: 'cancelled',
                    demand: work.demand,
                });
                return;
            }
            work.stage = 'rendering';
            await runCoordinatedPdfPageRender({
                owner: work.target.id,
                pageNumber: work.demand.pageNumber,
                pdfPage: work.pageLease.page,
                priority: LANE_ORDER[work.demand.lane],
                continuation: {
                    key: `${surfaceScopeId}:${work.key}`,
                    priority: LANE_CONTINUATION_PRIORITY[work.demand.lane],
                },
                signal: work.controller.signal,
                shouldStart: () => isDemandCurrent(work),
                startRender: () => work.target.start(work.prepared, work.pageLease!.page),
                watchdog: {
                    key: `raster-canvas-render:${surfaceScopeId}:${String(work.sequence)}:${String(work.retryCount)}`,
                    metadata: {
                        lane: work.demand.lane,
                        renderKey: work.demand.renderKey,
                        sourceId: work.sourceId,
                        targetId: work.target.id,
                    },
                    onRenderStall: payload => work.target.onRenderStall?.(payload),
                    payload: {
                        pageNumber: work.demand.pageNumber,
                        stage: 'canvas-render',
                        timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                    },
                    renderSupervisor,
                    shouldNotify: () => isDemandCurrent(work) && (
                        work.demand.lane === 'navigation-target'
                        || work.demand.lane === 'viewport-visible'
                    ),
                },
                captureSettlement: settlement => captureWorkSettlement(work, settlement),
            });
            if (!isDemandCurrent(work)) {
                discardPrepared(work);
                releaseReservation(work);
                settleWork(work, {
                    status: 'cancelled',
                    demand: work.demand,
                });
                return;
            }
            work.stage = 'committing';
            committed = work.target.commit(work.prepared, work.demand);
            if (!committed) {
                discardPrepared(work);
                releaseReservation(work);
                scheduleReattempt(work, {
                    status: 'discarded',
                    demand: work.demand,
                });
                return;
            }
            const reservation = work.reservation;
            work.prepared = null;
            work.reservation = null;
            const resident: IResidentRaster = {
                demand: work.demand,
                key: work.key,
                reservation,
                sourceId: work.sourceId,
                target: work.target,
            };
            const previous = residents.get(work.key);
            if (previous) {
                releaseResident(previous, 'raster-replaced');
            }
            residents.set(work.key, resident);
            surfaceBudget.enforceBudget();
            settleWork(work, {
                status: 'committed',
                demand: work.demand,
            });
        } catch (error) {
            if (work.prepared !== null) {
                discardPrepared(work);
            }
            releaseReservation(work);
            if (!isDemandCurrent(work)) {
                settleWork(work, {
                    status: 'cancelled',
                    demand: work.demand,
                });
            } else {
                scheduleReattempt(work, {
                    status: 'failed',
                    demand: work.demand,
                    error,
                });
            }
        } finally {
            await releasePageLease(work);
            if (inFlight.get(work.key) === work) {
                inFlight.delete(work.key);
            }
            armPendingReattempt(work);
            if (!committed && work.retryTimer === null && queued.get(work.key) !== work) {
                releaseTarget(work, 'raster-not-committed');
            }
            schedulePump();
        }
    }

    function pump() {
        if (!accepting) {
            return;
        }
        while (inFlight.size < maxConcurrency) {
            const work = takeNextWork();
            if (!work) {
                return;
            }
            if (!isDemandCurrent(work)) {
                settleWork(work, {
                    status: 'cancelled',
                    demand: work.demand,
                });
                continue;
            }
            inFlight.set(work.key, work);
            const execution = executeWork(work);
            work.execution = execution;
            void execution;
        }
    }

    function enqueue<TPrepared>(
        sourceId: string,
        demand: IPdfRasterDemand,
        target: IPdfRasterRenderTarget<TPrepared>,
        policyCompare: (left: IPdfRasterDemand, right: IPdfRasterDemand) => number,
        oneShot: boolean,
        resolve: ((outcome: TPdfRasterOutcome) => void) | null,
    ) {
        const key = createWorkKey(target.id, demand);
        const resident = residents.get(key);
        if (resident) {
            if (resident.demand.lane !== demand.lane) {
                resident.reservation.setPriority?.(LANE_ORDER[demand.lane]);
            }
            resident.demand = demand;
            resolve?.({
                status: 'committed',
                demand,
            });
            return key;
        }
        const existing = getIndexedWork(key);
        if (existing) {
            // Republished authoritative demand with the same render key is
            // still the same work. Advance its generation in place so the
            // current-demand guard does not cancel and restart that raster.
            existing.demand = demand;
            if (resolve) {
                const previousResolve = existing.resolve;
                existing.resolve = (outcome) => {
                    previousResolve?.(outcome);
                    resolve(outcome);
                };
            }
            return key;
        }
        const work: IRasterWork<TPrepared> = {
            controller: new AbortController(),
            coordinatedOperationSettlements: new Set(),
            demand,
            execution: null,
            key,
            oneShot,
            pageLease: null,
            policyCompare,
            prepared: null,
            reservation: null,
            resolve,
            retryCount: 0,
            retryTimer: null,
            sequence: nextSequence++,
            sourceId,
            stage: 'queued',
            target,
            targetReleased: false,
        };
        queued.set(key, work);
        schedulePump();
        return key;
    }

    function setDemand<TInput, TPrepared>(request: {
        sourceId: string;
        input: TInput;
        policy: IPdfRasterDemandPolicy<TInput>;
        target: IPdfRasterRenderTarget<TPrepared>;
    }) {
        if (!accepting) {
            return;
        }
        const demands = request.policy.expand(request.input).filter(demand => (
            isSameDocumentFence(demand.documentFence, options.documentFence)
        ));
        const nextKeys = new Set<string>();
        const previousKeys = demandKeysBySource.get(request.sourceId) ?? new Set<string>();
        for (const demand of demands) {
            const identity = createDemandIdentity(
                request.sourceId,
                request.target.id,
                demand.pageNumber,
            );
            currentDemandByIdentity.set(identity, demand);
            nextKeys.add(enqueue(
                request.sourceId,
                demand,
                request.target,
                request.policy.compareWithinLane,
                false,
                null,
            ));
        }
        demandKeysBySource.set(request.sourceId, nextKeys);
        for (const key of previousKeys) {
            if (nextKeys.has(key)) {
                continue;
            }
            const work = getIndexedWork(key);
            if (work?.sourceId === request.sourceId) {
                cancelWork(work, 'demand-replaced');
            }
            const resident = residents.get(key);
            if (resident?.sourceId === request.sourceId) {
                releaseResident(resident, 'demand-replaced');
            }
        }
        for (const [
            identity,
            demand,
        ] of currentDemandByIdentity) {
            if (
                identity.startsWith(`${request.sourceId}\0${request.target.id}\0`)
                && !nextKeys.has(createWorkKey(request.target.id, demand))
            ) {
                currentDemandByIdentity.delete(identity);
            }
        }
        schedulePump();
    }

    function request<TPrepared>(requestOptions: {
        sourceId: string;
        demand: IPdfRasterDemand;
        target: IPdfRasterRenderTarget<TPrepared>;
    }) {
        if (requestOptions.demand.lane !== 'navigation-target') {
            return Promise.reject(new TypeError('PdfPageRasterScheduler.request() accepts navigation-target demand only'));
        }
        if (
            !accepting
            || !isSameDocumentFence(requestOptions.demand.documentFence, options.documentFence)
        ) {
            return Promise.resolve({
                status: 'cancelled',
                demand: requestOptions.demand,
            } satisfies TPdfRasterOutcome);
        }
        return new Promise<TPdfRasterOutcome>((resolve) => {
            enqueue(
                requestOptions.sourceId,
                requestOptions.demand,
                requestOptions.target,
                (left, right) => left.ordinal - right.ordinal,
                true,
                resolve,
            );
        });
    }

    function invalidate(scope: IPdfRasterInvalidation) {
        if (
            scope.documentFence
            && !isSameDocumentFence(scope.documentFence, options.documentFence)
        ) {
            return;
        }
        const pages = scope.pages ? new Set(scope.pages) : null;
        const matches = (sourceId: string, demand: IPdfRasterDemand) => (
            (!scope.sourceId || sourceId === scope.sourceId)
            && (!pages || pages.has(demand.pageNumber))
        );
        const invalidatesDocument = Boolean(scope.documentFence)
            && !scope.sourceId
            && !pages;
        if (invalidatesDocument) {
            accepting = false;
        }
        for (const work of new Set([
            ...queued.values(),
            ...inFlight.values(),
            ...retryPending.values(),
        ])) {
            if (matches(work.sourceId, work.demand)) {
                cancelWork(work, scope.reason);
            }
        }
        for (const resident of [...residents.values()]) {
            if (matches(resident.sourceId, resident.demand)) {
                releaseResident(resident, scope.reason);
            }
        }
        for (const [
            sourceId,
            keys,
        ] of demandKeysBySource) {
            if (!scope.sourceId || sourceId === scope.sourceId) {
                for (const key of [...keys]) {
                    const work = getIndexedWork(key);
                    const resident = residents.get(key);
                    const demand = work?.demand ?? resident?.demand;
                    if (demand && (!pages || pages.has(demand.pageNumber))) {
                        keys.delete(key);
                    }
                }
            }
        }
    }

    async function cancelSource(sourceId: string) {
        const workSettlements = [...inFlight.values()]
            .filter(work => work.sourceId === sourceId)
            .map(work => work.execution)
            .filter((execution): execution is Promise<void> => execution !== null);
        invalidate({
            reason: 'source-cancelled',
            sourceId,
        });
        demandKeysBySource.delete(sourceId);
        for (const identity of [...currentDemandByIdentity.keys()]) {
            if (identity.startsWith(`${sourceId}\0`)) {
                currentDemandByIdentity.delete(identity);
            }
        }
        await Promise.allSettled(workSettlements);
    }

    function snapshot(): IPdfRasterSchedulerSnapshot {
        const queuedByLane = createLaneCounts();
        const inFlightByLane = createLaneCounts();
        let reservedPixels = 0;
        for (const work of queued.values()) {
            queuedByLane[work.demand.lane] += 1;
            reservedPixels += (work.reservation?.bytes ?? 0) / 4;
        }
        for (const work of inFlight.values()) {
            inFlightByLane[work.demand.lane] += 1;
            reservedPixels += (work.reservation?.bytes ?? 0) / 4;
        }
        for (const resident of residents.values()) {
            reservedPixels += resident.reservation.bytes / 4;
        }
        return {
            accepting,
            queueDepth: queued.size,
            queuedByLane,
            inFlightByLane,
            inFlightPages: [...inFlight.values()].map(work => ({
                lane: work.demand.lane,
                pageNumber: work.demand.pageNumber,
                sourceId: work.sourceId,
                targetId: work.target.id,
            })),
            residentPages: [...residents.values()].map(resident => ({
                lane: resident.demand.lane,
                pageNumber: resident.demand.pageNumber,
                sourceId: resident.sourceId,
                targetId: resident.target.id,
            })),
            reservedPixels,
        };
    }

    async function runDisposal() {
        const workSettlements = [...inFlight.values()]
            .map(work => work.execution)
            .filter((execution): execution is Promise<void> => execution !== null);
        invalidate({
            documentFence: options.documentFence,
            reason: 'scheduler-disposed',
        });
        await Promise.allSettled(workSettlements);
        surfaceBudget.releaseScope(surfaceScopeId);
    }

    function dispose() {
        // `accepting` already flips on whole-document invalidation, so it cannot
        // gate disposal: the scope must be released exactly once, and every
        // caller must await the same in-flight settlement.
        disposal ??= runDisposal();
        return disposal;
    }

    return {
        documentFence: options.documentFence,
        setDemand,
        request,
        invalidate,
        cancelSource,
        snapshot,
        dispose,
    };
}

const pdfDocumentRasterSchedulers = new WeakMap<IPdfDocument, IPdfPageRasterScheduler>();

export function ensurePdfPageRasterScheduler(
    document: IPdfDocument,
    options: {
        documentFence: IPdfRasterDocumentFence;
        leasePage: ICreatePdfPageRasterSchedulerOptions['leasePage'];
    },
) {
    const existing = pdfDocumentRasterSchedulers.get(document);
    if (existing) {
        return existing;
    }
    const scheduler = createPdfPageRasterScheduler({
        documentFence: options.documentFence,
        leasePage: options.leasePage,
    });
    pdfDocumentRasterSchedulers.set(document, scheduler);
    return scheduler;
}

export async function disposePdfPageRasterScheduler(document: IPdfDocument) {
    const scheduler = pdfDocumentRasterSchedulers.get(document);
    pdfDocumentRasterSchedulers.delete(document);
    await scheduler?.dispose();
}
