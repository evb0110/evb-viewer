import type { IWorkspaceCheckpointTab } from '@contracts/workspaceCheckpoint';
import { checkViewerInvariants } from '@app/modules/viewer-invariants/checkViewerInvariants';
import { readViewerSurface } from '@app/modules/viewer-invariants/readViewerSurface';
import { readViewerUserActions } from '@app/modules/viewer-invariants/viewerActionLog';
import type {
    IViewerInvariantReport,
    IViewerSurface,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';

const BUG_REPORT_SCHEMA_VERSION = 1;
const FNV_OFFSET_BASIS = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

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
    document: {
        /** Stable across a session, derived from page geometry only. */
        fingerprint: string;
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
 * A fingerprint of the document's page geometry: page count plus each mounted
 * page's rounded aspect ratio. It identifies a document across two bug reports
 * without carrying a byte of its content.
 */
function fingerprintDocument(surface: IViewerSurface | null) {
    const parts = [
        String(surface?.toolbarTotalPages ?? 0),
        ...(surface?.pages ?? []).map(page => (
            `${String(page.pageNumber)}:${(page.rect.width / Math.max(1, page.rect.height)).toFixed(3)}`
        )),
    ].join('|');
    let hash = FNV_OFFSET_BASIS;
    for (let index = 0; index < parts.length; index += 1) {
        hash ^= parts.charCodeAt(index);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function readCheckpointShape(root: Document): IViewerBugReportCheckpointShape {
    const panes = [...root.querySelectorAll<HTMLElement>('.editor-pane')];
    const tabElements = [...root.querySelectorAll<HTMLElement>('[data-tab-id]')];
    const {surface} = readViewerSurface(root);
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
                zoom: null,
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
        document: {
            fingerprint: fingerprintDocument(surface),
            pageCount: surface?.toolbarTotalPages ?? null,
        },
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
