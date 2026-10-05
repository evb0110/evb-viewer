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
    type IWorkspaceDocumentView,
    type IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { rememberReadingView } from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import {
    beginOpenSurfaceWithPageShape,
    readPdfPageShape,
} from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseWorkspaceDocumentLifecycleOptions {
    documentSession: IWorkspaceDocumentController;
    documentView: IWorkspaceDocumentView;
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
    /** Opens a file without an open transaction of its own; the caller runs it in one. */
    openPath: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    closeFailedDocument: () => Promise<boolean>;
    hasWorkingCopy: () => boolean;
    goToPage: (page: number, options?: IScrollToPageOptions) => void;
    formatBatchLabel: (values: {
        processed: number;
        total: number
    }) => string;
}

/**
 * Connects one DocumentWorkspace to its document controller and its tab's view. Every open
 * runs as a controller transaction that ends when the viewer presents the
 * document or reports why it could not; the workspace writes identity, dirty
 * state and view state through controller methods.
 */
export const useWorkspaceDocumentLifecycle = (options: IUseWorkspaceDocumentLifecycleOptions) => {
    const session = options.documentSession;
    const view = options.documentView;
    const snapshot = computed(() => session.snapshot.value);
    const activeOpen = computed(() => {
        const transaction = snapshot.value.activeTransaction;
        return transaction && transaction.kind !== 'close' ? transaction : null;
    });
    const hasDocument = computed(() => options.toolbarSnapshot.value.hasPdf || options.isDjvuMode.value);
    // The source of the open has been accepted; from here the viewer decides.
    const acceptedTransactionId = ref<string | null>(null);
    let pendingPage: number | null = null;
    // An open of a Recent file first asks whether it is gone; page commands
    // sent meanwhile wait for the open as they do once it has claimed the tab.
    let checkingOpenSource = false;
    const recent = useRecentFiles();

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
    watch(options.toolbarSnapshot, toolbar => view.publishToolbarSnapshot(toolbar), {immediate: true});
    watch(options.openBatchProgress, (progress) => {
        session.setOpeningLabel(progress && progress.total > 0
            ? options.formatBatchLabel({
                processed: Math.min(Math.max(progress.processed, 0), progress.total),
                total: progress.total,
            })
            : null);
    });

    // A document that fails outside an open, such as a reload that did not
    // load, is told when it fails; an open's failure is told when it ends.
    watch(options.readOpenFailure, (failure) => {
        if (failure && !activeOpen.value) {
            session.reportFailure(failure);
        }
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
            ? Math.max(1, Math.trunc(view.viewState.value.currentPage ?? 1))
            : 1;
        const path = request.target?.originalPath ?? null;
        // One page-shape read per open: the one its input started, or this one.
        const shapeSource = request.pageShapeSource === undefined ? path : request.pageShapeSource;
        beginOpenSurfaceWithPageShape(options.openSurface, {
            documentId: String(path ?? transactionId),
            documentRevision: `open-intent:${transactionId}`,
            provisional: true,
        }, initialPage, initialPage !== 1
            ? null
            : request.pageShape?.path === shapeSource ? request.pageShape : readPdfPageShape(shapeSource));
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

    async function runOpen(request: IWorkspaceOpenRequest, run: () => Promise<boolean>) {
        // A gone Recent file is told, and the place in the document this open
        // replaces is remembered, before the open claims the tab; a tab its
        // caller already claimed (a drop's new tab) and other files open at once.
        const opensNew = request.kind === 'open' && !activeOpen.value;
        const sourcePath = opensNew ? request.target?.originalPath : null;
        if (opensNew) {
            checkingOpenSource = true;
            const gone = await rememberReadingView(session).then(async () => Boolean(
                sourcePath && recent.recentFiles.value.some(file => file.originalPath === sourcePath)
                && await recent.forgetRecentFileIfMissing(sourcePath),
            )).finally(() => {
                checkingOpenSource = false;
            });
            if (gone) {
                pendingPage = null;
                return false;
            }
        }
        const hadDocument = identityHasDocument(snapshot.value.identity);
        let transactionId = null as string | null;
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
            // However the open ends (shown, failed, cancelled, superseded or
            // thrown), it gives back its surface claim.
            if (!presented && transactionId && options.openSurface.snapshot.value.identity?.documentRevision === `open-intent:${transactionId}`) {
                options.openSurface.reset();
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

    // A view of a document that is already open (a split's second view, or a
    // view that remounted in another pane) has no open transaction of its own.
    // Its surface starts at the page its view state names, as an open would.
    // A tab that owns a document it has not loaded here (a restored session,
    // a cold tab, a transferred tab) opens it when shown, at the page it was
    // left on. This restore is the open's only transaction: a nested one
    // would supersede it, and releasing it would reopen the surface at page 1.
    function presentWhenShown() {
        const current = snapshot.value;
        const path = current.identity.originalPath;
        if (!options.isShown() || current.phase !== 'presented') {
            return;
        }
        if (hasDocument.value) {
            if (options.openSurface.snapshot.value.phase === 'idle') {
                options.openSurface.begin({
                    documentId: String(current.identity.originalPath ?? current.identity.documentRef ?? current.sessionId),
                    documentRevision: `open-intent:view:${view.tabId}`,
                    provisional: true,
                }, null, Math.max(1, Math.trunc(view.viewState.value.currentPage ?? 1)));
            }
            return;
        }
        if (!path || (current.dirty && current.recoveryWorkingCopyPath)) {
            return;
        }
        void runOpen({
            kind: 'restore',
            target: {
                fileName: current.identity.fileName,
                originalPath: path,
                isDjvu: current.identity.isDjvu,
            },
        }, async () => didOpenDocument(await options.openPath(path)));
    }
    watch(
        [
            options.isShown,
            snapshot,
        ],
        presentWhenShown,
    );
    // The open runs through the workspace, which is complete only once it has
    // mounted; a tab shown at mount opens from here, not during setup.
    onMounted(presentWhenShown);

    // Closing ends the document's visual generation; Start re-arms from the
    // empty surface instead of inheriting the closed document's frame.
    watch(snapshot, (current) => {
        if (current.phase === 'empty' && current.activeTransaction === null && options.openSurface.snapshot.value.phase !== 'idle') {
            options.openSurface.reset();
        }
    }, {flush: 'sync'});

    // While an open has not claimed a surface yet, a page command waits for it.
    function goToPage(page: number, scrollOptions?: IScrollToPageOptions) {
        if (!activeOpen.value && !checkingOpenSource) {
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
        view.applyViewState(options.readViewState());
    }

    return {
        captureViewState,
        goToPage,
        runOpen,
    };
};
