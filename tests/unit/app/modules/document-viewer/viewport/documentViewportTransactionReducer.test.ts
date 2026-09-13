import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createDocumentViewportTransactionMachineState,
    isDocumentViewportRenderRequestCurrent,
    isDocumentViewportTargetRangeCurrent,
    reduceDocumentViewportTransactionMachine,
} from '@app/modules/document-viewer/viewport/documentViewportTransactionReducer';
import { createDocumentViewportRenderRequest } from '@app/modules/document-viewer/viewport/createDocumentViewportRenderRequest';
import type {
    IDocumentViewportTransactionBase,
    IDocumentViewportTransactionBeginEvent,
    IDocumentViewportTransactionCancellation,
    IDocumentViewportDocumentRef,
    IDocumentViewportRenderRequest,
} from '@app/modules/document-viewer/viewport/documentViewportTransactionTypes';

type TTestTransactionKind =
    | 'navigation'
    | 'render'
    | 'reload'
    | 'resize'
    | 'zoom'
    | 'search'
    | 'recovery'
    | 'warm';

type TTestTransactionSource =
    | 'paged'
    | 'continuous'
    | 'reload'
    | 'warm';

interface ITestFitPlan {pagedTargetRenderHandoff: 'pending' | 'consumed' | null;}

type TTestRenderRequest = IDocumentViewportRenderRequest<
    unknown,
    number,
    number,
    TTestTransactionSource,
    'authoritative' | 'interactive' | 'warm' | 'recovery'
>;

type TTestTransaction = IDocumentViewportTransactionBase<
    TTestTransactionKind,
    TTestTransactionSource,
    unknown,
    {
        start: number;
        end: number;
    },
    TTestRenderRequest,
    ITestFitPlan,
    null
>;

const documentRef: IDocumentViewportDocumentRef = {
    document: null,
    documentLoadToken: 1,
    documentVersion: 10,
};

const fitPlan: ITestFitPlan = {pagedTargetRenderHandoff: null};

const reloadCancellation: IDocumentViewportTransactionCancellation = {
    reason: 'reload',
    cancelInFlightRenders: true,
    bumpRenderVersion: true,
    preserveVisualContent: true,
};

function beginEvent(options: {
    kind: TTestTransactionKind;
    source: TTestTransactionSource;
    page?: number | undefined;
    fit?: ITestFitPlan | undefined;
}): IDocumentViewportTransactionBeginEvent<TTestTransaction> {
    const page = options.page ?? 1;
    return {
        type: 'BEGIN',
        transaction: {
            kind: options.kind,
            source: options.source,
            documentRef,
            target: {
                page,
                range: {
                    start: page,
                    end: page,
                },
                anchor: 'top',
            },
            fitPlan: options.fit ?? fitPlan,
            scrollPlan: null,
            createdAtMs: 100,
            userViewportInteractionEpoch: 0,
        },
    };
}

describe('document viewport transaction reducer', () => {
    it('supersedes an active authoritative transaction and records the cancelled id', () => {
        const first = reduceDocumentViewportTransactionMachine(
            createDocumentViewportTransactionMachineState<TTestTransaction>(),
            beginEvent({
                kind: 'navigation',
                source: 'paged',
                page: 2,
            }),
        );
        const second = reduceDocumentViewportTransactionMachine(
            first,
            beginEvent({
                kind: 'navigation',
                source: 'continuous',
                page: 3,
            }),
        );

        expect(first.active?.id).toBe(1);
        expect(second.active?.id).toBe(2);
        expect(second.cancelled).toHaveLength(1);
        expect(second.cancelled[0]).toMatchObject({
            id: 1,
            state: 'cancelled',
            cancellation: {
                reason: 'superseded',
                supersededByTransactionId: 2,
            },
        });
    });

    it('does not let warm or recovery work supersede authoritative navigation', () => {
        const active = reduceDocumentViewportTransactionMachine(
            createDocumentViewportTransactionMachineState<TTestTransaction>(),
            beginEvent({
                kind: 'navigation',
                source: 'paged',
                page: 2,
            }),
        );
        const warm = reduceDocumentViewportTransactionMachine(
            active,
            beginEvent({
                kind: 'warm',
                source: 'warm',
                page: 3,
            }),
        );
        const recovery = reduceDocumentViewportTransactionMachine(
            active,
            beginEvent({
                kind: 'recovery',
                source: 'warm',
                page: 4,
            }),
        );

        expect(warm).toBe(active);
        expect(recovery).toBe(active);
        expect(active.active?.target?.page).toBe(2);
    });

    it('creates render requests and validates stale request identity', () => {
        const active = reduceDocumentViewportTransactionMachine(
            createDocumentViewportTransactionMachineState<TTestTransaction>(),
            beginEvent({
                kind: 'zoom',
                source: 'continuous',
                page: 4,
            }),
        );
        const transaction = active.active;
        expect(transaction).not.toBeNull();

        const request = createDocumentViewportRenderRequest({
            transaction: transaction!,
            renderRequestId: 1,
            renderVersion: 5,
            priority: 'interactive',
        });
        const advanced = reduceDocumentViewportTransactionMachine(active, {
            type: 'ADVANCE',
            transactionId: transaction?.id ?? 0,
            state: 'render-requested',
            renderRequest: request,
        });

        expect(advanced.nextRenderRequestId).toBe(2);
        expect(isDocumentViewportRenderRequestCurrent(advanced.active, request)).toBe(true);
        expect(isDocumentViewportRenderRequestCurrent(null, request)).toBe(false);
    });

    it('cancels reload-affecting work and bumps render version when requested', () => {
        const active = reduceDocumentViewportTransactionMachine(
            createDocumentViewportTransactionMachineState<TTestTransaction>(),
            beginEvent({
                kind: 'navigation',
                source: 'paged',
            }),
        );
        const cancelled = reduceDocumentViewportTransactionMachine(active, {
            type: 'CANCEL',
            cancellation: reloadCancellation,
        });

        expect(cancelled.active).toBeNull();
        expect(cancelled.renderVersion).toBe(1);
        expect(cancelled.cancelled[0]).toMatchObject({
            id: 1,
            state: 'cancelled',
            cancellation: {
                reason: 'reload',
                bumpRenderVersion: true,
            },
        });
    });

    it('marks active and settled fit render handoffs as consumed once', () => {
        const active = reduceDocumentViewportTransactionMachine(
            createDocumentViewportTransactionMachineState<TTestTransaction>(),
            beginEvent({
                kind: 'render',
                source: 'paged',
                page: 4,
                fit: {pagedTargetRenderHandoff: 'pending'},
            }),
        );
        const renderRequested = reduceDocumentViewportTransactionMachine(active, {
            type: 'ADVANCE',
            transactionId: active.active?.id ?? 0,
            state: 'render-requested',
        });
        const consumedActive = reduceDocumentViewportTransactionMachine(renderRequested, {
            type: 'CONSUME_FIT_RENDER_HANDOFF',
            transactionId: active.active?.id ?? 0,
        });

        expect(consumedActive.active).toMatchObject({
            state: 'current-page-committed',
            fitPlan: { pagedTargetRenderHandoff: 'consumed' },
        });

        const settled = reduceDocumentViewportTransactionMachine(renderRequested, {
            type: 'ADVANCE',
            transactionId: active.active?.id ?? 0,
            state: 'settled',
        });
        const consumedSettled = reduceDocumentViewportTransactionMachine(settled, {
            type: 'CONSUME_FIT_RENDER_HANDOFF',
            transactionId: active.active?.id ?? 0,
        });

        expect(consumedSettled.settled).toMatchObject({
            state: 'settled',
            fitPlan: { pagedTargetRenderHandoff: 'consumed' },
        });
    });

    it('checks target range against the active target or visible range', () => {
        expect(isDocumentViewportTargetRangeCurrent(
            {
                start: 4,
                end: 5,
            },
            {
                start: 5,
                end: 6,
            },
            {
                start: 1,
                end: 1,
            },
        )).toBe(true);
        expect(isDocumentViewportTargetRangeCurrent(
            {
                start: 4,
                end: 5,
            },
            null,
            {
                start: 1,
                end: 3,
            },
        )).toBe(false);
    });
});
