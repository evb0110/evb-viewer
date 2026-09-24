import {useDocumentWorkspaceSurfaceMode} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSurfaceMode';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/public/runtime';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentIdentity,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

/** Scan Cleanup rasterizes the working copy, so only a real source counts. */
function hasScanCleanupSourceDocument(identity: IWorkspaceDocumentIdentity) {
    return Boolean(identity.workingCopyPath ?? identity.documentRef ?? identity.originalPath);
}

interface IDocumentWorkspaceScanCleanupSurfaceOptions {
    documentSession: IWorkspaceDocumentController | null;
    initialViewState: ITabViewSessionState | null;
    closeAllDropdowns: () => void;
    readDocumentKey: () => string | null | undefined;
    readSourceSha256?: () => string | null;
}

export const useDocumentWorkspaceScanCleanupSurface = (
    options: IDocumentWorkspaceScanCleanupSurfaceOptions,
) => {
    const {
        documentSession,
        initialViewState,
    } = options;
    const surface = useDocumentWorkspaceSurfaceMode({
        initialScanCleanup: documentSession?.viewState.value.scanCleanup
            ?? initialViewState?.scanCleanup
            ?? null,
        initialSurfaceMode: documentSession?.viewState.value.surfaceMode
            ?? initialViewState?.surfaceMode
            ?? 'reader',
        applyViewState: documentSession
            ? updates => documentSession.applyViewState({
                ...documentSession.viewState.value,
                ...updates,
            })
            : undefined,
        readScanCleanup: documentSession
            ? () => documentSession.viewState.value.scanCleanup ?? null
            : undefined,
        readSurfaceMode: documentSession
            ? () => documentSession.viewState.value.surfaceMode
            : undefined,
        clearScanCleanupViewState: documentSession
            ? () => {
                const {
                    scanCleanup: _scanCleanup,
                    ...viewState
                } = documentSession.viewState.value;
                documentSession.applyViewState(viewState);
            }
            : undefined,
    });

    function discardScanCleanupState() {
        surface.discardScanCleanupSessionState();
        void discardScanCleanupDocumentState(
            options.readDocumentKey(),
            options.readSourceSha256?.() ?? null,
        ).catch(() => undefined);
    }

    // Scan Cleanup edits a document; it cannot outlive one. The final tab keeps
    // its mounted workspace across a close, so without this the surface stays in
    // 'scan-cleanup' over an empty session and reopens there for the next
    // document, replaying a stale page selection against fresh source pages.
    if (documentSession) {
        watch(
            () => hasScanCleanupSourceDocument(documentSession.snapshot.value.identity),
            (hasDocument, hadDocument) => {
                if (hasDocument || hadDocument === false) {
                    return;
                }
                surface.closeScanCleanup();
                discardScanCleanupState();
            },
        );
    }

    function openScanCleanup() {
        options.closeAllDropdowns();
        surface.discardScanCleanupSessionState();
        surface.openScanCleanup();
    }

    function closeScanCleanup() {
        surface.closeScanCleanup();
        surface.discardScanCleanupSessionState();
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
        ...surface,
        closeScanCleanup,
        discardScanCleanupState,
        openScanCleanup,
    };
};
