import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type {
    TViewerResidencyState, TDocumentSidebarTab,  
} from '@app/modules/document-viewer/public';
import type {TScanCleanupPageOutputMapping} from '@contracts/scan-cleanup/domain';

export type TTabTemperature = 'hot' | 'warm' | 'cold';
export type TDocumentSurfaceMode = 'reader' | 'scan-cleanup';

export interface IScanCleanupTabSessionState {
    ownerId: string;
    previewPage: number;
    previewViewMode: 'original' | 'cleaned';
    pageMapping?: TScanCleanupPageOutputMapping;
}

export interface ITabViewSessionState {
    surfaceMode: TDocumentSurfaceMode;
    scanCleanup?: IScanCleanupTabSessionState;
    /** Optional for checkpoints written before page continuity was persisted. */
    currentPage?: number;
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    /** Optional for sessions written before whole-document view rotation. */
    viewRotation?: TPdfViewRotation;
    showSidebar: boolean;
    /** Optional for checkpoints written before the shared sidebar session existed. */
    sidebarTab?: TDocumentSidebarTab;
    /** Optional for backwards-compatible restore of older checkpoints. */
    sidebarWidth?: number;
    continuousScroll: boolean;
}

export interface ITabLifecycleState {
    tabId: string;
    temperature: TTabTemperature;
    viewerResidency: TViewerResidencyState;
    isReclaimCandidate: boolean;
    shouldMountHost: boolean;
}
