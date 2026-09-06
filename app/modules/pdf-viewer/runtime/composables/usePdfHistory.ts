import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
    currentPage: Ref<number>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
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
        currentPage,
        isAnySaving,
        isHistoryBusy,
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
            resetSearchCache,
            pageToRestore: normalizedPageToRestore,
        });
    }

    function waitForPdfReload(
        pageToRestore: number,
    ) {
        return preparePdfReloadWaiter(pageToRestore).promise;
    }

    function getCanUseHistory(direction: THistoryDirection) {
        return direction === 'undo'
            ? canUndo.value
            : canRedo.value;
    }

    function getTimelineHistorySource(direction: THistoryDirection) {
        return direction === 'undo'
            ? nextUndoSource.value
            : nextRedoSource.value;
    }

    function resolveHistoryRoute(direction: THistoryDirection): THistoryRoute {
        if (isAnySaving.value || !getCanUseHistory(direction)) {
            return {kind: 'blocked'};
        }

        return {
            kind: 'command',
            direction,
            source: getTimelineHistorySource(direction),
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
        route: Extract<THistoryRoute, {kind: 'command';}>,
        runHistory: () => Promise<boolean>,
    ) {
        if (isHistoryBusy.value) {
            return false;
        }
        isHistoryBusy.value = true;
        try {
            const historySource = route.source;
            if (!historySource) {
                reportMissingTimelineSource(route);
                return false;
            }
            if (historySource === 'file' && workingCopyPath.value) {
                clearOcrCache(workingCopyPath.value);
            }
            const pageToRestore = currentPage.value;
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
        } finally {
            isHistoryBusy.value = false;
        }
    }

    async function handleUndo() {
        const route = resolveHistoryRoute('undo');
        if (route.kind === 'blocked') {
            return;
        }
        await runTimelineHistoryRoute(route, undoHistory);
    }

    async function handleRedo() {
        const route = resolveHistoryRoute('redo');
        if (route.kind === 'blocked') {
            return;
        }
        await runTimelineHistoryRoute(route, redoHistory);
    }

    return {
        preparePdfReloadWaiter,
        waitForPdfReload,
        handleUndo,
        handleRedo,
    };
};
