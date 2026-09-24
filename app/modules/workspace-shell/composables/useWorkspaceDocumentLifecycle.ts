import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type {
    IWorkspaceOpenFailure,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import {
    identityHasDocument,
    type IWorkspaceDocumentController,
    type IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseWorkspaceDocumentLifecycleOptions {
    documentSession: IWorkspaceDocumentController;
    openSurface: IDocumentOpenSurfaceSession;
    isShown: () => boolean;
    fileName: TReadableRef<string | null>;
    originalPath: TReadableRef<TDocumentRef | null>;
    isDjvuMode: TReadableRef<boolean>;
    djvuSourcePath: TReadableRef<TDocumentRef | null>;
    documentRevisionInfo: TReadableRef<IDocumentRevisionInfo | null>;
    isDirty: TReadableRef<boolean>;
    openBatchProgress: TReadableRef<{
        processed: number;
        total: number
    } | null>;
    /** The first page is on screen, or the document failed. */
    documentOpenSettled: TReadableRef<boolean>;
    /** The document's pages are loaded, painted or not. */
    documentOpenAccepted: TReadableRef<boolean>;
    readOpenFailure: () => IWorkspaceOpenFailure | null;
    toolbarSnapshot: TReadableRef<IWorkspaceToolbarSnapshot>;
    readViewState: () => ITabViewSessionState;
    openPath: (path: TDocumentRef) => Promise<boolean>;
    closeFailedDocument: () => Promise<boolean>;
    hasWorkingCopy: () => boolean;
    goToPage: (page: number, options?: IScrollToPageOptions) => void;
    formatBatchLabel: (values: {
        processed: number;
        total: number
    }) => string;
}

/**
 * Connects one DocumentWorkspace to its tab's document controller. Every open
 * runs as a controller transaction that ends when the viewer presents the
 * document or reports why it could not; the workspace writes identity, dirty
 * state and view state through controller methods.
 */
export const useWorkspaceDocumentLifecycle = (options: IUseWorkspaceDocumentLifecycleOptions) => {
    const session = options.documentSession;
    const snapshot = computed(() => session.snapshot.value);
    const activeOpen = computed(() => {
        const transaction = snapshot.value.activeTransaction;
        return transaction && transaction.kind !== 'close' ? transaction : null;
    });
    const isOpening = computed(() => activeOpen.value !== null);
    const hasDocument = computed(() => (
        options.toolbarSnapshot.value.hasPdf || options.isDjvuMode.value
    ));
    // The source of the open has been accepted; from here the viewer decides.
    const acceptedTransactionId = ref<string | null>(null);
    let pendingPage: number | null = null;

    watch(() => {
        const djvuSource = options.isDjvuMode.value ? options.djvuSourcePath.value : null;
        return {
            fileName: djvuSource ? getDocumentRefBaseName(djvuSource) ?? options.fileName.value : options.fileName.value,
            originalPath: djvuSource ?? options.originalPath.value,
            isDjvu: options.isDjvuMode.value,
            revisionInfo: options.documentRevisionInfo.value,
        };
    }, document => session.commitDocument(document));
    watch(options.isDirty, dirty => session.setDirty(dirty));
    watch(options.toolbarSnapshot, toolbar => session.publishToolbarSnapshot(toolbar), {immediate: true});
    watch(options.openBatchProgress, (progress) => {
        session.setOpeningLabel(progress && progress.total > 0
            ? options.formatBatchLabel({
                processed: Math.min(Math.max(progress.processed, 0), progress.total),
                total: progress.total,
            })
            : null);
    });

    watch(
        [
            acceptedTransactionId,
            options.documentOpenSettled,
            options.documentOpenAccepted,
        ],
        ([
            acceptedId,
            settled,
            accepted,
        ]) => {
            const transaction = activeOpen.value;
            if (!transaction || transaction.id !== acceptedId) {
                return;
            }
            const failure = options.readOpenFailure();
            if (failure) {
                session.markFailed(failure);
            } else if (settled || (transaction.acceptDocumentWithoutVisual && accepted)) {
                session.markPresented();
            }
        },
    );

    function claimOpenSurface(transactionId: string, request: IWorkspaceOpenRequest) {
        const surface = options.openSurface.snapshot.value;
        if (surface.phase !== 'idle' && surface.phase !== 'ready' && surface.phase !== 'failed') {
            return;
        }
        const initialPage = request.kind === 'restore'
            ? Math.max(1, Math.trunc(session.viewState.value.currentPage ?? 1))
            : 1;
        options.openSurface.begin({
            documentId: String(request.target?.originalPath ?? transactionId),
            documentRevision: `open-intent:${transactionId}`,
            provisional: true,
        }, null, initialPage);
        if (pendingPage !== null) {
            options.openSurface.requestNavigation(pendingPage);
            pendingPage = null;
        }
        logPdfRenderTrace('pdf-open-surface-transaction-claimed', {
            documentId: options.openSurface.snapshot.value.identity?.documentId ?? null,
            generation: options.openSurface.snapshot.value.generation,
            transactionId,
        });
    }

    function releaseOpenSurface(transactionId: string) {
        if (options.openSurface.snapshot.value.identity?.documentRevision === `open-intent:${transactionId}`) {
            options.openSurface.reset();
        }
    }

    async function runOpen(request: IWorkspaceOpenRequest, run: () => Promise<boolean>) {
        const hadDocument = identityHasDocument(snapshot.value.identity);
        let transactionId: string | null = null;
        let presented = false;
        try {
            presented = await session.runOpen(request, async () => {
                transactionId = activeOpen.value?.id ?? null;
                if (transactionId) {
                    claimOpenSurface(transactionId, request);
                }
                const accepted = await run();
                if (!accepted) {
                    session.markFailed(options.readOpenFailure());
                } else if (transactionId && activeOpen.value?.id === transactionId) {
                    acceptedTransactionId.value = transactionId;
                }
                return accepted;
            });
        } finally {
            if (!presented && transactionId) {
                releaseOpenSurface(transactionId);
            }
        }
        // An open that fails on an empty tab gives the tab back to Start,
        // which then says why the file did not open. A generated result
        // belongs to the page that made it, which reports its own failure and
        // keeps an adopted working copy for Retry and Save As.
        if (
            !presented
            && request.kind === 'open'
            && !hadDocument
            && snapshot.value.phase === 'failed'
        ) {
            const generated = request.acceptDocumentWithoutVisual === true;
            if (!generated || !options.hasWorkingCopy()) {
                await options.closeFailedDocument();
            }
            if (generated) {
                session.dismissFailure();
            }
        }
        return presented;
    }

    // A tab that owns a document it has not loaded here (a restored session,
    // a cold tab, a transferred tab) opens it when shown.
    watch(
        [
            options.isShown,
            snapshot,
        ],
        ([
            shown,
            current,
        ]) => {
            const path = current.identity.originalPath;
            if (
                !shown
                || current.phase !== 'presented'
                || !path
                || hasDocument.value
                || (current.dirty && current.recoveryWorkingCopyPath)
            ) {
                return;
            }
            void runOpen({
                kind: 'restore',
                target: {
                    fileName: current.identity.fileName,
                    originalPath: path,
                    isDjvu: current.identity.isDjvu,
                },
            }, () => options.openPath(path));
        },
        {immediate: true},
    );

    // Closing ends the document's visual generation; Start re-arms from the
    // empty surface instead of inheriting the closed document's frame.
    watch(snapshot, (current) => {
        if (current.phase === 'empty' && current.activeTransaction === null && options.openSurface.snapshot.value.phase !== 'idle') {
            options.openSurface.reset();
        }
    }, {flush: 'sync'});

    // While an open has not claimed a surface yet, a page command waits for it.
    function goToPage(page: number, scrollOptions?: IScrollToPageOptions) {
        if (!isOpening.value) {
            options.goToPage(page, scrollOptions);
            return;
        }
        if (options.openSurface.viewportSession.value.identity === null) {
            pendingPage = page;
            return;
        }
        options.openSurface.requestNavigation(page);
    }

    function captureViewState() {
        session.applyViewState(options.readViewState());
    }

    return {
        captureViewState,
        goToPage,
        runOpen,
    };
};
