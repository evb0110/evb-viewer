import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
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
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import {
    rememberReadingView,
    seedOpeningPreflight,
} from '@app/modules/workspace-shell/document-sessions/recentReadingView';
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
    isDjvuMode: TReadableRef<boolean>;
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
 * document or reports why it could not; the workspace writes dirty state
 * and view state through controller methods.
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
        const path = request.target?.originalPath ?? null;
        const shapeSource = request.pageShapeSource === undefined ? path : request.pageShapeSource;
        const pageShape = request.pageShape?.path === shapeSource ? request.pageShape : readPdfPageShape(shapeSource);
        let transactionId = null as string | null;
        let presented = false;
        try {
            presented = await session.runOpen({
                ...request,
                pageShape,
            }, async (shape, id) => {
                transactionId = id;
                const surface = options.openSurface.snapshot.value;
                if (surface.phase === 'idle' || surface.phase === 'ready' || surface.phase === 'failed') {
                    beginOpenSurfaceWithPageShape(options.openSurface, {
                        documentId: String(path ?? id),
                        documentRevision: `open-intent:${id}`,
                        provisional: true,
                    }, request.kind === 'restore' ? view.readingAnchor.value ?? view.viewState.value.currentPage ?? 1 : 1,
                    shape ?? null, request.kind === 'open' && !request.carriesView ? {
                        seed: view => seedOpeningPreflight(session, view),
                        shown: !hadDocument,
                    } : null);
                    if (pendingPage !== null) {
                        options.openSurface.requestNavigation(pendingPage);
                        pendingPage = null;
                    }
                }
                const accepted = await run();
                if (activeOpen.value?.id === id) {
                    if (accepted) {
                        acceptedTransactionId.value = id;
                    } else {
                        session.markFailed(options.readOpenFailure());
                    }
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

    // A remounted view starts from its retained place through the same opening
    // initializer. An unloaded document restores in one transaction; nesting
    // another would supersede it and reopen its surface at page 1.
    function presentWhenShown() {
        const current = snapshot.value;
        const path = current.identity.originalPath;
        if (!options.isShown() || current.phase !== 'presented' || current.activeTransaction !== null) {
            return;
        }
        if (hasDocument.value) {
            if (options.openSurface.snapshot.value.phase === 'idle') {
                beginOpenSurfaceWithPageShape(options.openSurface, {
                    documentId: String(current.identity.originalPath ?? current.identity.documentRef ?? current.sessionId),
                    documentRevision: `open-intent:view:${view.tabId}`,
                    provisional: true,
                }, view.readingAnchor.value ?? view.viewState.value.currentPage ?? 1, null);
            }
        } else if (path && !(current.dirty && current.recoveryWorkingCopyPath)) {
            void runOpen({
                kind: 'restore',
                target: {
                    fileName: current.identity.fileName,
                    originalPath: path,
                    isDjvu: current.identity.isDjvu,
                },
            }, async () => didOpenDocument(await options.openPath(path)));
        }
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
