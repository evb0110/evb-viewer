import type {
    ComputedRef,
    Ref,
} from 'vue';
import { until } from '@vueuse/core';
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
    admitOpenedDocument,
    didPresent,
    type TDocumentOpenOutcome,
    type TWorkspaceOpenFinish,
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
import type { IDocumentDirectOpenOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseWorkspaceDocumentLifecycleOptions {
    documentSession: IWorkspaceDocumentController;
    documentView: IWorkspaceDocumentView;
    openSurface: IDocumentOpenSurfaceSession;
    isShown: () => boolean;
    isDjvuMode: TReadableRef<boolean>;
    /** The first page is on screen, or the document failed. */
    documentOpenSettled: TReadableRef<boolean>;
    readOpenFailure: () => IWorkspaceOpenFailure | null;
    toolbarSnapshot: TReadableRef<IWorkspaceToolbarSnapshot>;
    readViewState: () => ITabViewSessionState;
    /** Opens a file without an open transaction of its own; the caller runs it in one. */
    openPath: (path: TDocumentRef, options?: IDocumentDirectOpenOptions) => Promise<TDocumentOpenOutcome>;
    closeFailedDocument: () => Promise<boolean>;
    /** An open this view ran showed its document, or accepted it where no view had to. */
    onOpened: () => void;
    hasWorkingCopy: () => boolean;
    goToPage: (page: number, options?: IScrollToPageOptions) => void;
}

/**
 * Connects one DocumentWorkspace to its document controller and its tab's view. Every open
 * runs as a controller transaction that ends with its document's presentation
 * in the views, or why it could not; the workspace writes dirty state
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
    let pendingPage: number | null = null;
    // An open of a Recent file first asks whether it is gone; page commands
    // sent meanwhile wait for the open as they do once it has claimed the tab.
    let checkingOpenSource = false;
    const recent = useRecentFiles();

    // A page operation owns its reload failure, and an open the failure of
    // its document; any other failure is told here.
    watch(options.readOpenFailure, (failure) => {
        if (failure && !activeOpen.value && session.operationLease.activeKind.value !== 'page-operation') {
            session.reportFailure(failure);
        }
    });

    // An open presents when its first page is on screen in this view, told by
    // the view's open surface: after a PDF's source job presented, and for a
    // page source, whose open job does not reach the document's DjVu activation.
    function presentInView(transactionId: string) {
        return until(computed((): TWorkspaceOpenFinish | null => {
            const failure = options.readOpenFailure();
            if (activeOpen.value?.id !== transactionId) return {status: 'superseded'};
            if (failure) return {status: 'failed', failure};
            return options.documentOpenSettled.value ? {status: 'presented'} : null;
        })).not.toBeNull();
    }

    async function runOpen(request: IWorkspaceOpenRequest, run: () => Promise<TDocumentOpenOutcome>) {
        // A gone Recent file is told, and the place in the document this open
        // replaces is remembered, before the open claims the tab; a tab its
        // caller already claimed (a drop's new tab) and other files open at once.
        const opensNew = request.kind === 'open' && !activeOpen.value;
        const sourcePath = opensNew ? request.target?.originalPath : null;
        if (opensNew) {
            checkingOpenSource = true;
            const gone = await rememberReadingView(session, view.tabId).then(async () => Boolean(
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
        let finish: TWorkspaceOpenFinish = {status: 'cancelled'};
        try {
            finish = await session.runOpen({
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
                const admission = admitOpenedDocument(await run(), options.readOpenFailure);
                if (!admission && activeOpen.value?.id === id) {
                    session.markFailed(options.readOpenFailure());
                }
                // A generated or recovered document needs no paint, only its source job's load.
                return admission && {presentation: (admission.presentation ?? Promise.resolve({status: 'presented'})).then(finish => (
                    finish.status !== 'presented' ? finish : request.acceptDocumentWithoutVisual ? {status: 'accepted-without-visual'} : presentInView(id)))};
            }).finished;
        } finally {
            // However the open ends (shown, failed, cancelled, superseded or
            // thrown), it gives back its surface claim.
            if (!didPresent(finish) && transactionId && options.openSurface.snapshot.value.identity?.documentRevision === `open-intent:${transactionId}`) {
                options.openSurface.reset();
            }
        }
        const presented = didPresent(finish);
        // A tab whose open did not present shows what it held before.
        if (presented) options.onOpened();
        else presentWhenShown();
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
            // Reloading a tab the session already held is not the reader
            // opening the file: Recent Files keeps their last open. A file the
            // reader opened into a hidden tab opens as theirs.
            const openOptions = session.isDeferredReaderOpen() ? {} : {recordRecent: false};
            void runOpen({
                kind: 'restore',
                target: {
                    fileName: current.identity.fileName,
                    originalPath: path,
                    isDjvu: current.identity.isDjvu,
                },
            }, () => options.openPath(path, openOptions));
        }
    }
    // A view opens or presents its document when shown and when given one;
    // an open that ends without presenting re-presents what the tab held.
    watch(
        [
            options.isShown,
            () => snapshot.value.identity.documentSessionKey,
        ],
        presentWhenShown,
    );

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
        // The open runs through the workspace, which is complete only once it
        // has mounted and attached; a tab shown then opens, not during setup.
        presentWhenShown,
        runOpen,
    };
};
