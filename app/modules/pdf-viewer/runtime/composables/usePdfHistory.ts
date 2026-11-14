import type {
    TDocumentCommitReceipt, TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import {runWithoutDocumentOperationLease} from '@app/utils/runWithoutDocumentOperationLease';
import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';
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
    /** Waits for the reload in every view of the document, each kept on its page moved through `mapPage`. */
    prepareReload: (mapPage: (page: number) => number) => {promise: Promise<void>; cancel: () => void};
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
    clearOcrCache: (path: TDocumentRef) => void;
    undoHistory: () => Promise<boolean>;
    redoHistory: () => Promise<boolean>;
}) => {
    const {
        prepareReload,
        isAnySaving,
        prepareHistory,
        mapHistoryPage,
        canUndo,
        canRedo,
        nextUndoSource,
        nextRedoSource,
        workingCopyPath,
        clearOcrCache,
        undoHistory,
        redoHistory,
    } = deps;

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
        const reloadWaiter = historySource === 'file'
            ? prepareReload(page => mapHistoryPage?.(direction, page) ?? page)
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
        canUndo,
        canRedo,
        isHistoryBusy: deps.isHistoryBusy ?? computed(() => false),
        handleUndo: (onCommitted?: TDocumentCommitReceipt) => runHistory('undo', onCommitted),
        handleRedo: (onCommitted?: TDocumentCommitReceipt) => runHistory('redo', onCommitted),
    };
};
