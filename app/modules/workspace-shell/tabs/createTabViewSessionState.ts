import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

export function createTabViewSessionState(
    snapshot: IWorkspaceToolbarSnapshot,
    previousState?: ITabViewSessionState | null,
): ITabViewSessionState {
    return {
        surfaceMode: previousState?.surfaceMode ?? 'reader',
        ...(previousState?.scanCleanup ? {scanCleanup: previousState.scanCleanup} : {}),
        currentPage: Math.max(1, Math.trunc(snapshot.currentPage)),
        zoom: snapshot.zoom,
        zoomMode: snapshot.zoomMode,
        fitMode: snapshot.fitMode,
        viewMode: snapshot.viewMode,
        viewRotation: snapshot.viewRotation,
        showSidebar: snapshot.showSidebar,
        sidebarTab: snapshot.sidebarTab ?? 'thumbnails',
        sidebarWidth: snapshot.sidebarWidth ?? 272,
        continuousScroll: snapshot.continuousScroll,
    };
}
