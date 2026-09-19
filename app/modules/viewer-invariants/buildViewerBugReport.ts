import type { IWorkspaceCheckpointTab } from '@contracts/workspaceCheckpoint';
import { checkViewerInvariants } from '@app/modules/viewer-invariants/checkViewerInvariants';
import { readViewerSurface } from '@app/modules/viewer-invariants/readViewerSurface';
import { readViewerUserActions } from '@app/modules/viewer-invariants/viewerActionLog';
import type { IViewerInvariantReport } from '@app/modules/viewer-invariants/viewerInvariantTypes';

const BUG_REPORT_SCHEMA_VERSION = 2;
const ZOOM_DISPLAY_SELECTOR = '#editor-global-toolbar-host .zoom-controls-display-value';
const SOURCE_PATH_SELECTOR = '.status-bar-path';

/**
 * The checkpoint fields that describe a session rather than its content. Tab
 * ids, file names and document refs are deliberately reduced to presence
 * booleans so a bundle can be attached to an issue as it is.
 */
type TRedactedCheckpointTab = Pick<
    IWorkspaceCheckpointTab,
    'currentPage' | 'isDirty' | 'zoom' | 'zoomMode'
> & {
    isActive: boolean;
    paneIndex: number;
};

export interface IViewerBugReportCheckpointShape {
    activeTabIndex: number;
    paneCount: number;
    tabCount: number;
    tabs: TRedactedCheckpointTab[];
    version: 1;
}

export interface IViewerBugReport {
    appVersion: string;
    capturedAt: string;
    checkpointShape: IViewerBugReportCheckpointShape;
    devicePixelRatio: number;
    /** Filled in by the main process, which owns the build identity. */
    build?: {
        dirty: boolean;
        gitSha: string | null;
    };
    document: {
        /**
         * Filled in by the main process: the first 16 hex of the sha256 of the
         * source file's bytes, which matches the corpus manifest's prefix and
         * carries no content. `unavailable` when the source is not a file.
         */
        sourceHash?: string;
        pageCount: number | null;
    };
    invariantReport: IViewerInvariantReport;
    recentActions: ReturnType<typeof readViewerUserActions>;
    schemaVersion: number;
    toolbar: {
        continuousScroll: boolean | null;
        currentPage: number | null;
        totalPages: number | null;
        viewMode: string | null;
        zoomMode: string | null;
    };
    windowSize: {
        innerHeight: number;
        innerWidth: number;
        outerHeight: number;
        outerWidth: number;
    };
}

/**
 * The zoom a reader sees, read from the toolbar's own display. A percentage
 * becomes the factor the checkpoint format stores.
 */
function readRenderedZoom(root: Document) {
    const text = root.querySelector(ZOOM_DISPLAY_SELECTOR)?.textContent?.trim() ?? '';
    const parsed = Number.parseFloat(text.replace('%', '').replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return text.includes('%') ? Number((parsed / 100).toFixed(4)) : parsed;
}

/**
 * The path the status bar shows for the open document. It never enters the
 * report: the caller hands it to the main process, which turns it into a
 * content hash of the file's bytes and discards it.
 */
export function readDocumentSourcePath(root: Document = document) {
    return root.querySelector(SOURCE_PATH_SELECTOR)?.textContent?.trim() ?? '';
}

function readCheckpointShape(root: Document): IViewerBugReportCheckpointShape {
    const panes = [...root.querySelectorAll<HTMLElement>('.editor-pane')];
    const tabElements = [...root.querySelectorAll<HTMLElement>('[data-tab-id]')];
    const {surface} = readViewerSurface(root);
    const zoom = readRenderedZoom(root);
    return {
        activeTabIndex: tabElements.findIndex(tab => tab.classList.contains('is-active')),
        paneCount: panes.length,
        tabCount: tabElements.length,
        tabs: tabElements.map((tab): TRedactedCheckpointTab => {
            const isActive = tab.classList.contains('is-active');
            return {
                currentPage: isActive ? surface?.toolbarPageNumber ?? null : null,
                isActive,
                isDirty: tab.classList.contains('is-dirty'),
                paneIndex: panes.findIndex(pane => pane.contains(tab)),
                zoom: isActive ? zoom : null,
                zoomMode: isActive ? surface?.zoomMode ?? null : null,
            };
        }),
        version: 1,
    };
}

export function buildViewerBugReport(appVersion: string, root: Document = document): IViewerBugReport {
    const {surface} = readViewerSurface(root);
    return {
        appVersion,
        capturedAt: new Date().toISOString(),
        checkpointShape: readCheckpointShape(root),
        devicePixelRatio: window.devicePixelRatio,
        document: {pageCount: surface?.toolbarTotalPages ?? null},
        invariantReport: checkViewerInvariants({remember: false}),
        recentActions: readViewerUserActions(),
        schemaVersion: BUG_REPORT_SCHEMA_VERSION,
        toolbar: {
            continuousScroll: surface?.continuousScroll ?? null,
            currentPage: surface?.toolbarPageNumber ?? null,
            totalPages: surface?.toolbarTotalPages ?? null,
            viewMode: surface?.viewMode ?? null,
            zoomMode: surface?.zoomMode ?? null,
        },
        windowSize: {
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            outerHeight: window.outerHeight,
            outerWidth: window.outerWidth,
        },
    };
}
