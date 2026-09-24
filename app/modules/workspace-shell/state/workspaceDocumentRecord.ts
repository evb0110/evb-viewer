import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceToolbarSnapshot,
    type IWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type {
    IScanCleanupTabSessionState,
    ITabViewSessionState,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { TScanCleanupPageOutputMapping } from '@contracts/scan-cleanup/domain';
import { getWorkspaceViewerCapabilitiesForDocumentType } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

export type TWorkspaceDocumentTabState = Pick<ITab, 'fileName' | 'originalPath' | 'documentInstanceId' | 'isDirty' | 'isDjvu'>;

export interface IWorkspaceDocumentRecord {
    tab: TWorkspaceDocumentTabState;
    documentIdentity: IDocumentRevisionInfo | null;
    toolbarSnapshot: IWorkspaceToolbarSnapshot;
    viewState: ITabViewSessionState;
}

interface ICreateWorkspaceDocumentRecordOptions {
    tab?: TTabUpdate | TWorkspaceDocumentTabState | undefined;
    documentIdentity?: IDocumentRevisionInfo | null | undefined;
    toolbarSnapshot?: Partial<IWorkspaceToolbarSnapshot> | undefined;
    viewState?: ITabViewSessionState | undefined;
}

interface ICreatePendingWorkspaceDocumentRecordOptions {
    previousToolbarSnapshot?: IWorkspaceToolbarSnapshot | undefined;
    previousViewState?: ITabViewSessionState | undefined;
}

function normalizeTabState(tab?: TTabUpdate | TWorkspaceDocumentTabState): TWorkspaceDocumentTabState {
    return {
        fileName: tab?.fileName ?? null,
        originalPath: tab?.originalPath ?? null,
        ...(tab?.documentInstanceId === undefined ? {} : {documentInstanceId: tab.documentInstanceId}),
        isDirty: tab?.isDirty ?? false,
        isDjvu: tab?.isDjvu ?? false,
    };
}

function normalizeWorkspaceToolbarSnapshot(
    snapshot: Partial<IWorkspaceToolbarSnapshot> = createDefaultWorkspaceToolbarSnapshot(),
): IWorkspaceToolbarSnapshot {
    const normalized = {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...snapshot,
        viewerCapabilities: {
            ...createDefaultWorkspaceViewerCapabilities(),
            ...snapshot.viewerCapabilities,
        },
    };

    // An opening snapshot with zero pages is still waiting for metadata. A
    // positive count came from prepared geometry and is safe to expose before
    // the first visual commits.
    if (normalized.hasPdf && (!normalized.isOpeningDocument || normalized.totalPages > 0)) {
        normalized.currentPage = Math.max(1, Math.floor(normalized.currentPage));
        normalized.totalPages = Math.max(normalized.currentPage, Math.floor(normalized.totalPages));
        return normalized;
    }

    normalized.currentPage = 1;
    normalized.totalPages = 0;
    return normalized;
}

export function createWorkspaceDocumentRecord(
    options: ICreateWorkspaceDocumentRecordOptions = {},
): IWorkspaceDocumentRecord {
    const toolbarSnapshot = normalizeWorkspaceToolbarSnapshot(options.toolbarSnapshot);
    return {
        tab: normalizeTabState(options.tab),
        documentIdentity: options.documentIdentity ?? null,
        toolbarSnapshot,
        viewState: options.viewState ?? createTabViewSessionState(toolbarSnapshot),
    };
}

export function createPendingWorkspaceViewState(snapshot: IWorkspaceToolbarSnapshot): ITabViewSessionState {
    return createTabViewSessionState(snapshot);
}

export function createWorkspaceDocumentRecordFromTab(tab: ITab): IWorkspaceDocumentRecord {
    return createWorkspaceDocumentRecord({ tab });
}

export function createPendingWorkspaceDocumentRecord(
    tab: TTabUpdate,
    options: ICreatePendingWorkspaceDocumentRecordOptions = {},
): IWorkspaceDocumentRecord {
    const previousToolbarSnapshot = options.previousToolbarSnapshot ?? createDefaultWorkspaceToolbarSnapshot();
    const previousViewState = options.previousViewState ?? createTabViewSessionState(previousToolbarSnapshot);
    const tabState = normalizeTabState(tab);
    const toolbarSnapshot = normalizeWorkspaceToolbarSnapshot({
        ...previousToolbarSnapshot,
        hasPdf: Boolean(tabState.fileName) || Boolean(tabState.originalPath) || tabState.isDjvu,
        isOpeningDocument: true,
        isDjvuMode: tabState.isDjvu,
        // Page position starts at one so the replaced document cannot leak
        // into the incoming one.
        currentPage: 1,
        totalPages: 0,
        viewerCapabilities: getWorkspaceViewerCapabilitiesForDocumentType(tabState.isDjvu ? 'djvu' : 'pdf'),
    });
    return createWorkspaceDocumentRecord({
        tab: tabState,
        toolbarSnapshot,
        // View preferences survive replacement, but page position belongs to
        // the document being replaced and must not leak into the new open.
        viewState: {
            ...previousViewState,
            currentPage: 1,
        },
    });
}

// Equality below is field-wise instead of JSON.stringify so hot-path record
// publishes stop serializing full records. The Record<keyof T, true> key maps
// fail compilation when a field is added without a comparator, so the equality
// can never silently become looser than the previous stringify comparison.
// The constraint pins every compared field to a primitive so `===` stays a
// value comparison; an object or array field fails to compile here and needs
// its own structural comparator instead.
type TShallowEqualityField = string | number | boolean | null | undefined;

function createShallowKeyEquality<T extends Partial<Record<keyof T, TShallowEqualityField>>>(keyFlags: Record<keyof T, true>) {
    const keys = Object.keys(keyFlags) as Array<keyof T>;
    return (first: T, second: T) => keys.every(key => first[key] === second[key]);
}

const areViewerCapabilitiesEqual = createShallowKeyEquality<IWorkspaceViewerCapabilities>({
    closeableDocument: true,
    continuousScroll: true,
    conversionBanner: true,
    conversionDialog: true,
    crop: true,
    optimizePdf: true,
    pdfDocument: true,
    pdfMutationActions: true,
    print: true,
    regionCapture: true,
    repairSave: true,
    save: true,
    saveAs: true,
    sidebar: true,
    viewMode: true,
    viewRotation: true,
});

const areToolbarSnapshotPrimitivesEqual = createShallowKeyEquality<Omit<IWorkspaceToolbarSnapshot, 'viewerCapabilities'>>({
    canExportDocx: true,
    canOptimizePdf: true,
    canRedo: true,
    canRepairSave: true,
    canSave: true,
    canUndo: true,
    continuousScroll: true,
    currentPage: true,
    dragMode: true,
    effectiveZoom: true,
    fitMode: true,
    hasOpenError: true,
    hasPdf: true,
    initialVisualReady: true,
    isAnySaving: true,
    isCapturingRegion: true,
    isCropSelecting: true,
    isDjvuMode: true,
    isExportingDocx: true,
    isFitHeightActive: true,
    isFitWidthActive: true,
    isHistoryBusy: true,
    isOpeningDocument: true,
    isPageOperationInProgress: true,
    isPlacingPageNote: true,
    isPreparingCurrentPagePrint: true,
    isPreparingPrint: true,
    isSaving: true,
    isSavingAs: true,
    selectedPageCount: true,
    showSidebar: true,
    sidebarTab: true,
    sidebarWidth: true,
    totalPages: true,
    viewMode: true,
    viewRotation: true,
    zoom: true,
    zoomMode: true,
});

export function areWorkspaceToolbarSnapshotsEqual(
    first: IWorkspaceToolbarSnapshot,
    second: IWorkspaceToolbarSnapshot,
) {
    return areToolbarSnapshotPrimitivesEqual(first, second)
        && areViewerCapabilitiesEqual(first.viewerCapabilities, second.viewerCapabilities);
}

function areScanCleanupPageMappingsEqual(
    first: TScanCleanupPageOutputMapping | undefined,
    second: TScanCleanupPageOutputMapping | undefined,
) {
    if (first === second) {
        return true;
    }
    if (!first || !second) {
        return false;
    }
    const firstKeys = Object.keys(first);
    if (firstKeys.length !== Object.keys(second).length) {
        return false;
    }
    return firstKeys.every((key) => {
        if (!Object.hasOwn(second, key)) {
            return false;
        }
        const firstPages = first[key] ?? [];
        const secondPages = second[key] ?? [];
        return firstPages.length === secondPages.length
            && firstPages.every((page, index) => page === secondPages[index]);
    });
}

const areScanCleanupPrimitivesEqual = createShallowKeyEquality<Omit<IScanCleanupTabSessionState, 'pageMapping'>>({
    ownerId: true,
    previewPage: true,
    previewViewMode: true,
});

function areScanCleanupStatesEqual(
    first: IScanCleanupTabSessionState | undefined,
    second: IScanCleanupTabSessionState | undefined,
) {
    if (first === second) {
        return true;
    }
    if (!first || !second) {
        return false;
    }
    return areScanCleanupPrimitivesEqual(first, second)
        && areScanCleanupPageMappingsEqual(first.pageMapping, second.pageMapping);
}

const areViewStatePrimitivesEqual = createShallowKeyEquality<Omit<ITabViewSessionState, 'scanCleanup'>>({
    continuousScroll: true,
    currentPage: true,
    effectiveZoom: true,
    fitMode: true,
    showSidebar: true,
    sidebarTab: true,
    sidebarWidth: true,
    surfaceMode: true,
    viewMode: true,
    viewRotation: true,
    zoom: true,
    zoomMode: true,
});

export function areTabViewSessionStatesEqual(
    first: ITabViewSessionState,
    second: ITabViewSessionState,
) {
    return areViewStatePrimitivesEqual(first, second)
        && areScanCleanupStatesEqual(first.scanCleanup, second.scanCleanup);
}

const areDocumentRevisionInfoFieldsEqual = createShallowKeyEquality<IDocumentRevisionInfo>({
    authority: true,
    contentRevision: true,
    documentRef: true,
    mintedAt: true,
    token: true,
    version: true,
});

export function areDocumentRevisionInfosEqual(
    first: IDocumentRevisionInfo | null,
    second: IDocumentRevisionInfo | null,
) {
    if (first === second) {
        return true;
    }
    if (!first || !second) {
        return false;
    }
    return areDocumentRevisionInfoFieldsEqual(first, second);
}

const areTabStatesEqual = createShallowKeyEquality<TWorkspaceDocumentTabState>({
    documentInstanceId: true,
    fileName: true,
    isDirty: true,
    isDjvu: true,
    originalPath: true,
});

// No `-?` modifier: tsgo 7 stops correlating the map's call signatures with it,
// and every record field is required anyway.
const recordFieldComparators: {
    [K in keyof IWorkspaceDocumentRecord]: (
        first: IWorkspaceDocumentRecord[K],
        second: IWorkspaceDocumentRecord[K],
    ) => boolean;
} = {
    tab: areTabStatesEqual,
    documentIdentity: areDocumentRevisionInfosEqual,
    toolbarSnapshot: areWorkspaceToolbarSnapshotsEqual,
    viewState: areTabViewSessionStatesEqual,
};

const recordFieldKeys = Object.keys(recordFieldComparators) as Array<keyof IWorkspaceDocumentRecord>;

function areRecordFieldsEqual<K extends keyof IWorkspaceDocumentRecord>(
    key: K,
    first: IWorkspaceDocumentRecord,
    second: IWorkspaceDocumentRecord,
) {
    return recordFieldComparators[key](first[key], second[key]);
}

export function areWorkspaceDocumentRecordsEqual(
    first: IWorkspaceDocumentRecord | null | undefined,
    second: IWorkspaceDocumentRecord | null | undefined,
) {
    const firstRecord = first ?? null;
    const secondRecord = second ?? null;
    if (firstRecord === secondRecord) {
        return true;
    }
    if (!firstRecord || !secondRecord) {
        return false;
    }
    return recordFieldKeys.every(key => areRecordFieldsEqual(key, firstRecord, secondRecord));
}
