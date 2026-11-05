import type {
    TDocumentCommitReceipt, TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import {runWithoutDocumentOperationLease} from '@app/utils/runWithoutDocumentOperationLease';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';
import type { IPdfReloadWaiterViewer } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
import { createPdfReloadWaiter } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
import { BrowserLogger } from '@app/utils/browserLogger';

type THistoryDirection = 'undo' | 'redo';
type THistoryRoute = (
    | {kind: 'blocked';}
    | {
        kind: 'command';
        direction: THistoryDirection;
        source: TWorkspaceUndoSource | null;
    }
);

const HISTORY_LOG_SECTION = 'pdf-history';

export const usePdfHistory = (deps: {
    pdfDocument: Ref<IPdfDocument | null>;
    pdfViewerRef: Ref<IPdfReloadWaiterViewer | null>;
    openSurface?: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'> | undefined;
    currentPage: Ref<number>;
    isAnySaving: Ref<boolean>;
    prepareHistory: () => void | Promise<void>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    isHistoryBusy?: Readonly<Ref<boolean>>;
    runWithDocumentOperationLease?: <T>(kind: TDocumentOperationKind, operation: () => Promise<T>) => Promise<T>;
    mapHistoryPage?: (direction: THistoryDirection, page: number) => number;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    nextUndoSource: Ref<TWorkspaceUndoSource | null>;
    nextRedoSource: Ref<TWorkspaceUndoSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    resetSearchCache: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    undoHistory: () => Promise<boolean>;
    redoHistory: () => Promise<boolean>;
}) => {
    const {
        pdfDocument,
        pdfViewerRef,
        openSurface,
        currentPage,
        isAnySaving,
        prepareHistory,
        mapHistoryPage,
        canUndo,
        canRedo,
        nextUndoSource,
        nextRedoSource,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache,
        undoHistory,
        redoHistory,
    } = deps;

    /**
     * Starts watching for a PDF document instance swap and resolves when
     * the reload completes (or times out). A cancel path is exposed so
     * undo/redo no-op operations can tear the watcher down immediately.
     */
    function preparePdfReloadWaiter(
        pageToRestore: number,
    ) {
        const normalizedPageToRestore = Math.max(1, Math.floor(pageToRestore));

        return createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef,
            ...(openSurface ? {openSurface} : {}),
            resetSearchCache,
            pageToRestore: normalizedPageToRestore,
        });
    }

    function waitForPdfReload(
        pageToRestore: number,
    ) {
        return preparePdfReloadWaiter(pageToRestore).promise;
    }

    function resolveHistoryRoute(direction: THistoryDirection): THistoryRoute {
        if (isAnySaving.value || !(direction === 'undo' ? canUndo.value : canRedo.value)) {
            return {kind: 'blocked'};
        }

        return {
            kind: 'command',
            direction,
            source: direction === 'undo' ? nextUndoSource.value : nextRedoSource.value,
        };
    }

    function reportMissingTimelineSource(route: Extract<THistoryRoute, {kind: 'command';}>) {
        BrowserLogger.warn(
            HISTORY_LOG_SECTION,
            `${route.direction === 'undo' ? 'Undo' : 'Redo'} requested but no timeline history source was available`,
            {
                direction: route.direction,
                canUndo: canUndo.value,
                canRedo: canRedo.value,
            },
        );
    }

    async function runTimelineHistoryRoute(
        direction: THistoryDirection,
        runHistory: () => Promise<boolean>,
    ) {
        await prepareHistory();
        const route = resolveHistoryRoute(direction);
        if (route.kind === 'blocked') {
            return false;
        }
        const historySource = route.source;
        if (!historySource) {
            reportMissingTimelineSource(route);
            return false;
        }
        if (historySource === 'file' && workingCopyPath.value) {
            clearOcrCache(workingCopyPath.value);
        }
        const pageToRestore = mapHistoryPage?.(direction, currentPage.value) ?? currentPage.value;
        const reloadWaiter = historySource === 'file'
            ? preparePdfReloadWaiter(pageToRestore)
            : null;
        const didRun = await runHistory();
        if (didRun && reloadWaiter) {
            await reloadWaiter.promise;
        } else if (reloadWaiter) {
            reloadWaiter.cancel();
        }
        return didRun;
    }

    const runHistory = (direction: THistoryDirection, onCommitted?: TDocumentCommitReceipt) => (
        (deps.runWithDocumentOperationLease ?? runWithoutDocumentOperationLease)('history', async () => {
            const didRun = await runTimelineHistoryRoute(direction, direction === 'undo' ? undoHistory : redoHistory);
            const revision = deps.documentRevisionToken?.value;
            if (didRun && revision) onCommitted?.(revision);
            return didRun;
        })
    );

    return {
        preparePdfReloadWaiter,
        waitForPdfReload,
        canUndo,
        canRedo,
        isHistoryBusy: deps.isHistoryBusy ?? computed(() => false),
        handleUndo: (onCommitted?: TDocumentCommitReceipt) => runHistory('undo', onCommitted),
        handleRedo: (onCommitted?: TDocumentCommitReceipt) => runHistory('redo', onCommitted),
    };
};
