import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/public/runtime';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentIdentity,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {
    IScanCleanupTabSessionState,
    TDocumentSurfaceMode,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

/** Scan Cleanup rasterizes the working copy, so only a real source counts. */
function hasScanCleanupSourceDocument(identity: IWorkspaceDocumentIdentity) {
    return Boolean(identity.workingCopyPath ?? identity.documentRef ?? identity.originalPath);
}

interface IDocumentWorkspaceScanCleanupSurfaceOptions {
    documentSession: IWorkspaceDocumentController;
    closeAllDropdowns: () => void;
    readDocumentKey: () => string | null | undefined;
    readSourceSha256?: () => string | null;
}

/** Which surface the tab shows, reader or Scan Cleanup; the tab's view state owns it. */
export const useDocumentWorkspaceScanCleanupSurface = (
    options: IDocumentWorkspaceScanCleanupSurfaceOptions,
) => {
    const {documentSession} = options;
    const surfaceMode = computed<TDocumentSurfaceMode>({
        get: () => documentSession.viewState.value.surfaceMode ?? 'reader',
        set: surfaceMode => documentSession.applyViewState({
            ...documentSession.viewState.value,
            surfaceMode,
        }),
    });
    const scanCleanupSessionState = computed(() => documentSession.viewState.value.scanCleanup ?? null);
    // Set once the lazily loaded cleanup surface has painted, so the reader
    // stays laid out underneath until then.
    const workspaceMounted = ref(false);
    watch(surfaceMode, () => {
        workspaceMounted.value = false;
    });

    function updateScanCleanupSessionState(scanCleanup: IScanCleanupTabSessionState) {
        documentSession.applyViewState({
            ...documentSession.viewState.value,
            scanCleanup,
        });
    }

    /** Forgets the saved scan-cleanup view state so the next entry starts fresh. */
    function discardScanCleanupSessionState() {
        const {
            scanCleanup: _scanCleanup,
            ...viewState
        } = documentSession.viewState.value;
        documentSession.applyViewState(viewState);
    }

    function discardScanCleanupState() {
        discardScanCleanupSessionState();
        void discardScanCleanupDocumentState(
            options.readDocumentKey(),
            options.readSourceSha256?.() ?? null,
        ).catch(() => undefined);
    }

    // Scan Cleanup edits a document; it cannot outlive one. The final tab keeps
    // its mounted workspace across a close, so without this the surface stays in
    // 'scan-cleanup' over an empty session and reopens there for the next
    // document, replaying a stale page selection against fresh source pages.
    watch(
        () => hasScanCleanupSourceDocument(documentSession.snapshot.value.identity),
        (hasDocument, hadDocument) => {
            if (hasDocument || hadDocument === false) {
                return;
            }
            surfaceMode.value = 'reader';
            discardScanCleanupState();
        },
    );

    function openScanCleanup() {
        options.closeAllDropdowns();
        discardScanCleanupSessionState();
        surfaceMode.value = 'scan-cleanup';
    }

    function closeScanCleanup() {
        surfaceMode.value = 'reader';
        discardScanCleanupSessionState();
        // Leaving the panel is not closing the source document. Reset the
        // ephemeral view/preferences while retaining completed authoritative
        // detection for a same-identity reopen.
        void discardScanCleanupDocumentState(
            options.readDocumentKey(),
            options.readSourceSha256?.() ?? null,
            {discardDetection: false},
        ).catch(() => undefined);
    }

    return {
        surfaceMode,
        scanCleanupSessionState,
        workspaceMounted,
        updateScanCleanupSessionState,
        closeScanCleanup,
        discardScanCleanupState,
        openScanCleanup,
    };
};
