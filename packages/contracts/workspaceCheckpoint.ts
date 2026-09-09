import {parsePaneId} from '@contracts/editorPanes';
import type {
    TEditorLayoutNode,
    TPaneId,
} from '@contracts/editorPanes';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseTabId,
    type TTabId,
} from '@contracts/windowTabs';
import type {
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';
import {
    parseEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

const MAX_CHECKPOINT_TABS = 128;

export type TWorkspaceCheckpointSurfaceMode = 'reader' | 'scan-cleanup';

export interface IWorkspaceCheckpointAnnotationRecovery {
    readonly artifactId: string;
    readonly documentInstanceId: string;
    readonly workingCopyRef: TDocumentRef | null;
    readonly workingByteRevision: string;
    readonly annotationMutationGeneration: number;
    /** Present only in the renderer-to-main capture and main-to-renderer claim. */
    readonly payload?: unknown;
}

export interface IWorkspaceCheckpointTab {
    readonly tabId: TTabId;
    readonly paneId: TPaneId | null;
    readonly fileName: string | null;
    readonly sourceRef: TDocumentRef | null;
    readonly workingCopyRef: TDocumentRef | null;
    readonly requiresSaveAsOnFirstSave?: boolean;
    readonly isDirty: boolean;
    readonly isDjvu: boolean;
    readonly currentPage: number | null;
    readonly zoom: number | null;
    readonly zoomMode: TZoomMode | null;
    readonly continuousScroll?: boolean | null;
    readonly viewMode?: TPdfViewMode | null;
    readonly viewRotation?: TPdfViewRotation | null;
    readonly annotationRecovery?: IWorkspaceCheckpointAnnotationRecovery;
    /** Persist only the active surface. Large scan-cleanup state stays file-backed. */
    readonly surfaceMode?: TWorkspaceCheckpointSurfaceMode;
}

export interface IWorkspaceCheckpointPane {
    readonly paneId: TPaneId;
    readonly tabIds: readonly TTabId[];
    readonly activeTabId: TTabId | null;
}

export interface IWorkspaceCheckpoint {
    readonly version: 1;
    readonly capturedAt: TEpochMs;
    readonly activePaneId: TPaneId | null;
    readonly activeTabId: TTabId | null;
    readonly layout: TEditorLayoutNode | null;
    readonly panes: readonly IWorkspaceCheckpointPane[];
    readonly tabs: readonly IWorkspaceCheckpointTab[];
}

function isZoomMode(value: unknown): value is TZoomMode {
    return value === 'custom' || value === 'fit-height' || value === 'fit-width';
}

function isViewMode(value: unknown): value is TPdfViewMode {
    return value === 'single' || value === 'facing' || value === 'facing-first-single';
}

function isViewRotation(value: unknown): value is TPdfViewRotation {
    return value === 0 || value === 90 || value === 180 || value === 270;
}

function decodeNullableString(value: unknown) {
    return value === null || typeof value === 'string' ? value : undefined;
}

// The parse helpers report a rejected value as null, but these decoders reserve
// null for a persisted absent value and undefined for a rejected one. Without
// the conversion a malformed id would restore as an absent one instead of
// discarding the checkpoint.
function decodeNullablePaneId(value: unknown): TPaneId | null | undefined {
    return value === null
        ? null
        : value === undefined
            ? undefined
            : parsePaneId(value) ?? undefined;
}

function decodeNullableTabId(value: unknown): TTabId | null | undefined {
    return value === null
        ? null
        : value === undefined
            ? undefined
            : parseTabId(value) ?? undefined;
}

function decodeNullableDocumentRef(value: unknown): TDocumentRef | null | undefined {
    return value === null
        ? null
        : value === undefined
            ? undefined
            : parseDocumentRef(value) ?? undefined;
}

function decodeAnnotationRecovery(value: unknown): IWorkspaceCheckpointAnnotationRecovery | undefined {
    if (!isRecord(value)
        || typeof value.artifactId !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.artifactId)
        || typeof value.documentInstanceId !== 'string'
        || value.documentInstanceId.length === 0
        || value.documentInstanceId.length > 512
        || typeof value.workingByteRevision !== 'string'
        || value.workingByteRevision.length === 0
        || value.workingByteRevision.length > 512
        || typeof value.annotationMutationGeneration !== 'number'
        || !Number.isSafeInteger(value.annotationMutationGeneration)
        || value.annotationMutationGeneration < 0) {
        return undefined;
    }
    const workingCopyRef = decodeNullableDocumentRef(value.workingCopyRef);
    if (workingCopyRef === undefined) {
        return undefined;
    }
    return {
        artifactId: value.artifactId,
        documentInstanceId: value.documentInstanceId,
        workingCopyRef,
        workingByteRevision: value.workingByteRevision,
        annotationMutationGeneration: value.annotationMutationGeneration,
        ...(value.payload === undefined ? {} : {payload: value.payload}),
    };
}

function decodeLayout(value: unknown, depth = 0): TEditorLayoutNode | null | undefined {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || depth > 16) {
        return undefined;
    }
    const paneId = parsePaneId(value.paneId);
    if (value.type === 'leaf' && paneId !== null) {
        return {
            type: 'leaf',
            paneId,
        };
    }
    if (
        value.type !== 'split'
        || typeof value.id !== 'string'
        || (value.orientation !== 'horizontal' && value.orientation !== 'vertical')
        || typeof value.ratio !== 'number'
        || !Number.isFinite(value.ratio)
    ) {
        return undefined;
    }
    const first = decodeLayout(value.first, depth + 1);
    const second = decodeLayout(value.second, depth + 1);
    if (!first || !second) {
        return undefined;
    }
    return {
        type: 'split',
        id: value.id,
        orientation: value.orientation,
        ratio: value.ratio,
        first,
        second,
    };
}

export function decodeWorkspaceCheckpoint(value: unknown): IWorkspaceCheckpoint | null {
    const capturedAt = isRecord(value) ? parseEpochMs(value.capturedAt) : null;
    if (
        !isRecord(value)
        || value.version !== 1
        || capturedAt === null
        || !Array.isArray(value.panes)
        || value.panes.length > 32
        || !Array.isArray(value.tabs)
        || value.tabs.length > MAX_CHECKPOINT_TABS
    ) {
        return null;
    }
    const activePaneId = decodeNullablePaneId(value.activePaneId);
    const activeTabId = decodeNullableTabId(value.activeTabId);
    const layout = decodeLayout(value.layout);
    if (activePaneId === undefined || activeTabId === undefined || layout === undefined) {
        return null;
    }
    const panes: IWorkspaceCheckpointPane[] = [];
    for (const candidate of value.panes) {
        const paneId = isRecord(candidate) ? parsePaneId(candidate.paneId) : null;
        const tabIds = isRecord(candidate) && Array.isArray(candidate.tabIds) && candidate.tabIds.length <= MAX_CHECKPOINT_TABS
            ? candidate.tabIds.map(parseTabId)
            : null;
        if (!isRecord(candidate) || paneId === null || tabIds === null || tabIds.some(tabId => tabId === null)) {
            return null;
        }
        const paneActiveTabId = decodeNullableTabId(candidate.activeTabId);
        if (paneActiveTabId === undefined) {
            return null;
        }
        panes.push({
            paneId,
            tabIds: tabIds.filter((tabId): tabId is TTabId => tabId !== null),
            activeTabId: paneActiveTabId,
        });
    }
    const tabs: IWorkspaceCheckpointTab[] = [];
    for (const candidate of value.tabs) {
        if (!isRecord(candidate)) {
            return null;
        }
        const tabId = parseTabId(candidate.tabId);
        const paneId = decodeNullablePaneId(candidate.paneId);
        const fileName = decodeNullableString(candidate.fileName);
        const sourceRef = decodeNullableDocumentRef(candidate.sourceRef);
        const workingCopyRef = decodeNullableDocumentRef(candidate.workingCopyRef);
        const requiresSaveAsOnFirstSave = candidate.requiresSaveAsOnFirstSave === undefined
            ? undefined
            : typeof candidate.requiresSaveAsOnFirstSave === 'boolean'
                ? candidate.requiresSaveAsOnFirstSave
                : null;
        const currentPage = candidate.currentPage === null ? null
            : typeof candidate.currentPage === 'number' && Number.isSafeInteger(candidate.currentPage) && candidate.currentPage > 0
                ? candidate.currentPage : undefined;
        const zoom = candidate.zoom === null ? null
            : typeof candidate.zoom === 'number' && Number.isFinite(candidate.zoom) && candidate.zoom > 0
                ? candidate.zoom : undefined;
        const zoomMode = candidate.zoomMode === null ? null
            : isZoomMode(candidate.zoomMode)
                ? candidate.zoomMode : undefined;
        const continuousScroll = candidate.continuousScroll === undefined
            ? undefined
            : candidate.continuousScroll === null ? null
                : typeof candidate.continuousScroll === 'boolean' ? candidate.continuousScroll : undefined;
        const viewMode = candidate.viewMode === undefined
            ? undefined
            : candidate.viewMode === null ? null
                : isViewMode(candidate.viewMode)
                    ? candidate.viewMode : undefined;
        const viewRotation = candidate.viewRotation === undefined
            ? undefined
            : candidate.viewRotation === null ? null
                : typeof candidate.viewRotation === 'number'
                    && Number.isSafeInteger(candidate.viewRotation)
                    && isViewRotation(candidate.viewRotation)
                    ? candidate.viewRotation : undefined;
        const surfaceMode: TWorkspaceCheckpointSurfaceMode | null | undefined = candidate.surfaceMode === undefined
            ? undefined
            : candidate.surfaceMode === 'reader' || candidate.surfaceMode === 'scan-cleanup'
                ? candidate.surfaceMode
                : null;
        const annotationRecovery = candidate.annotationRecovery === undefined
            ? undefined
            : decodeAnnotationRecovery(candidate.annotationRecovery);
        if (tabId === null || paneId === undefined || fileName === undefined
            || sourceRef === undefined || workingCopyRef === undefined || typeof candidate.isDirty !== 'boolean'
            || requiresSaveAsOnFirstSave === null
            || typeof candidate.isDjvu !== 'boolean' || currentPage === undefined || zoom === undefined || zoomMode === undefined
            || (candidate.continuousScroll !== undefined && continuousScroll === undefined)
            || (candidate.viewMode !== undefined && viewMode === undefined)
            || (candidate.viewRotation !== undefined && viewRotation === undefined)
            || (candidate.surfaceMode !== undefined && surfaceMode === null)) {
            return null;
        }
        if (candidate.annotationRecovery !== undefined && annotationRecovery === undefined) {
            return null;
        }
        tabs.push({
            tabId,
            paneId,
            fileName,
            sourceRef,
            workingCopyRef,
            ...(requiresSaveAsOnFirstSave === undefined ? {} : {requiresSaveAsOnFirstSave}),
            isDirty: candidate.isDirty,
            isDjvu: candidate.isDjvu,
            currentPage,
            zoom,
            zoomMode,
            ...(continuousScroll === undefined ? {} : {continuousScroll}),
            ...(viewMode === undefined ? {} : {viewMode}),
            ...(viewRotation === undefined ? {} : {viewRotation}),
            ...(surfaceMode === undefined || surfaceMode === null ? {} : {surfaceMode}),
            ...(annotationRecovery === undefined ? {} : {annotationRecovery}),
        });
    }
    return {
        version: 1,
        capturedAt,
        activePaneId,
        activeTabId,
        layout,
        panes,
        tabs,
    };
}
