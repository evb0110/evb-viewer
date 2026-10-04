import type {
    IPdfSemanticAnchor,
    IRecentReadingView,
} from '@contracts/recentReadingView';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import {
    createPageNavigationRequest,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/public';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentView,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import { getDocumentRecentFilesCapability } from '@app/utils/platformDocuments';
import { BrowserLogger } from '@app/utils/browserLogger';

/** The reader followed from an open's start, so their moves outrank a restored place. */
export interface IWorkspaceReaderFollow {
    moved(): boolean;
    /** Sets the open's admitted reading seed, which stands in for that source's defaults while the open runs. */
    seed(state: Parameters<IWorkspaceExpose['restoreViewState']>[0], source: TDocumentRef): void;
    /** Once the open settles, stops following and brings `anchor` to the view's center unless the reader moved. */
    finish(anchor: IPdfSemanticAnchor | null): Promise<void>;
}

// The tab of the view in use is the document context's knowledge
// (createDocumentViews keeps it after that view unmounts). The window's close
// handshake runs outside the editor panes that host those contexts, so each
// context lends its lookup here.
const viewInUseTabIds = new WeakMap<IWorkspaceDocumentController, () => string | null>();

export function registerViewInUse(controller: IWorkspaceDocumentController, readTabId: () => string | null) {
    viewInUseTabIds.set(controller, readTabId);
}

// Main proves which bytes a view belongs to from what the renderer holds: a
// PDF's working copy, or the DjVu source its open was granted.
function readSourceRef(identity: IWorkspaceDocumentIdentity) {
    return identity.isDjvu ? identity.originalPath : identity.workingCopyPath;
}

// A mounted view reads its live toolbar; an unmounted one its retained state.
function captureReadingView(view: IWorkspaceDocumentView): IRecentReadingView | null {
    const toolbar = view.toolbarSnapshot.value;
    const workspace = view.mountedWorkspace.value;
    const place = workspace ? toolbar : {
        ...toolbar,
        ...view.viewState.value,
    };
    if (toolbar.totalPages < 1) {
        return null;
    }
    const currentPage = Math.min(Math.max(1, Math.trunc(place.currentPage ?? 1)), toolbar.totalPages);
    const anchor = workspace?.captureReadingAnchor?.() ?? null;
    return {
        currentPage,
        pageCount: toolbar.totalPages,
        zoom: place.zoom,
        zoomMode: place.zoomMode,
        viewMode: place.viewMode,
        continuousScroll: place.continuousScroll,
        viewRotation: place.viewRotation ?? 0,
        // An anchor on another page than the toolbar's is not the place the reader sees.
        ...(anchor?.page === currentPage ? {anchor} : {}),
    };
}

/**
 * Remembers where the reader left the document with its Recent entry, from
 * the view `tabId` names or else the view last in use, mounted or not. Callers
 * await it before the source it proves is released. A failed write is
 * reported, never taken as remembered.
 */
export async function rememberReadingView(controller: IWorkspaceDocumentController | null, tabId?: string) {
    const identity = controller?.snapshot.value.identity;
    const viewTabId = tabId ?? (controller && viewInUseTabIds.get(controller)?.());
    const view = viewTabId ? controller?.views.value.get(viewTabId) : undefined;
    const sourceRef = identity ? readSourceRef(identity) : null;
    const reading = view && sourceRef ? captureReadingView(view) : null;
    if (!reading || !sourceRef) {
        return;
    }
    try {
        await getDocumentRecentFilesCapability().recentFiles.rememberReadingView(sourceRef, reading);
    } catch (error) {
        BrowserLogger.error('recent-files', 'The reading view was not remembered', error, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
    }
}

/**
 * The document's file lifecycle remembers the place before a close releases
 * it, and seeds a normal open when its source is admitted. (An open that
 * replaces the document remembers it before it claims the view, while the
 * view still shows the old place.)
 */
export function createReadingViewLifecycleHooks(
    controller: IWorkspaceDocumentController,
    getOpenSurface: () => IDocumentOpenSurfaceSession | null,
): IWorkspaceViewerLifecycleHooks {
    return {
        beforeClose: () => rememberReadingView(controller),
        beforeSourcePresented: (source, pageCount) => seedOpeningSource(getOpenSurface(), source, pageCount),
    };
}

type TOpeningSurface = Pick<IDocumentOpenSurfaceSession, 'navigate'>;
type TOpeningWorkspace = Pick<IWorkspaceExpose, 'followReader'>;

interface IOpeningReader {
    reader: IWorkspaceReaderFollow;
    workspace: TOpeningWorkspace;
    anchor: IPdfSemanticAnchor | null;
}

// The normal open a view's surface is claimed for, with its reader followed
// from the open's start. The open's source admission seeds it.
const openingReaders = new WeakMap<TOpeningSurface, IOpeningReader>();

/** A normal open starts following its view's reader; a newer open replaces it. */
export function followOpeningReader(openSurface: TOpeningSurface, workspace: TOpeningWorkspace) {
    const reader = workspace.followReader?.();
    const opening = reader ? {
        reader,
        workspace,
        anchor: null,
    } : null;
    if (opening) {
        openingReaders.set(openSurface, opening);
    }
    return opening;
}

/**
 * Seeds the normal open of `sourceRef` once its source is admitted and before
 * its pages are drawn: main admits the bytes as those the reader left, the
 * admitted source itself has the page count the view was left at, and neither
 * the reader nor a newer open has moved the view since the open began.
 * The page goes out as the opening's own restore navigation, so the first page
 * drawn is the reader's.
 */
export async function seedOpeningSource(
    openSurface: TOpeningSurface | null,
    sourceRef: TDocumentRef,
    sourcePageCount: Promise<number | null>,
) {
    const opening = openSurface ? openingReaders.get(openSurface) : undefined;
    if (!openSurface || !opening) {
        return;
    }
    let reading: IRecentReadingView | null = null;
    try {
        reading = await getDocumentRecentFilesCapability().recentFiles.readingView(sourceRef);
    } catch (error) {
        BrowserLogger.warn('recent-files', 'The reading view could not be read', error);
    }
    const pageCount = await sourcePageCount;
    if (!reading || reading.pageCount !== pageCount || opening.reader.moved() || openingReaders.get(openSurface) !== opening) {
        return;
    }
    opening.reader.seed({
        ...reading,
        currentPage: null,
    }, sourceRef);
    openSurface.navigate(createPageNavigationRequest(reading.anchor?.page ?? reading.currentPage, 'restore'));
    opening.anchor = reading.anchor ?? null;
}

/** Ends the open's following; a presented seeded open takes its anchor. */
export async function finishOpeningReader(openSurface: TOpeningSurface, opening: IOpeningReader, presented: boolean) {
    if (openingReaders.get(openSurface) === opening) {
        openingReaders.delete(openSurface);
    }
    await opening.reader.finish(presented ? opening.anchor : null);
}
