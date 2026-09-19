import { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/public/domContracts';
import type {
    IViewerChromeRect,
    IViewerInvariantNoteWindow,
    IViewerInvariantOverlay,
    IViewerInvariantPage,
    IViewerRect,
    IViewerSurface,
    TViewerViewMode,
    TViewerZoomMode,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';

const ACTIVE_WORKSPACE_HOST_SELECTORS = [
    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
    '.editor-pane.is-active .workspace-host',
];
const ANNOTATION_ENTITY_SELECTOR = '.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]';
const ANNOTATION_VISUAL_SELECTOR = '[data-annotation-visual]';
const FACING_ROW_SELECTOR = '.pdf-viewer-page-row';
const MIN_HOST_SIZE_PX = 100;
const NOTE_WINDOW_SELECTOR = '.note-window[data-annotation-id]';
const PAGE_TRACK_SELECTOR = '[data-pdf-page-track]';
const TOOLBAR_PAGE_CONTROLS_SELECTOR = '.page-controls';
const VIEWPORT_SELECTOR = '[data-document-viewer-chassis-viewport], #pdf-viewer';
/**
 * The application's own surfaces. A document overlay that covers one of them
 * is wrong whatever the viewer is showing, so they are read from the rendered
 * shell rather than assumed from the viewport box.
 */
const CHROME_SELECTORS = [
    '#editor-global-toolbar-host',
    '.sidebar-wrapper',
    '.tab-bar',
    '.status-bar',
] as const;

function toRect(rect: DOMRect): IViewerRect {
    return {
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width,
    };
}

function isPaintedElement(element: Element | null): element is HTMLElement {
    if (!(element instanceof HTMLElement) || !element.isConnected) {
        return false;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
        return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function findActiveWorkspaceHost(root: Document) {
    for (const selector of ACTIVE_WORKSPACE_HOST_SELECTORS) {
        const host = root.querySelector<HTMLElement>(selector);
        if (host && isPaintedElement(host)) {
            return host;
        }
    }
    const paintedHosts = [...root.querySelectorAll<HTMLElement>('.workspace-host')].filter(candidate => (
        isPaintedElement(candidate)
        && candidate.getBoundingClientRect().width > MIN_HOST_SIZE_PX
        && candidate.getBoundingClientRect().height > MIN_HOST_SIZE_PX
    ));
    return paintedHosts.length === 1 ? paintedHosts[0] ?? null : null;
}

/**
 * The unobscured document viewport: the scroller's client box, which already
 * excludes a classic scrollbar. Overlay scrollbars float above content and are
 * outside this model on purpose.
 */
function readViewportRect(viewport: HTMLElement): IViewerRect {
    const rect = viewport.getBoundingClientRect();
    return {
        height: viewport.clientHeight,
        left: rect.left + viewport.clientLeft,
        top: rect.top + viewport.clientTop,
        width: viewport.clientWidth,
    };
}

function readPages(host: HTMLElement): IViewerInvariantPage[] {
    const containers = [...host.querySelectorAll<HTMLElement>(
        `${pdfViewerDomSelectors.pageContainer}[data-page]:not(.page_container--buffered)`,
    )];
    return containers
        .map((container): IViewerInvariantPage | null => {
            const pageNumber = Number.parseInt(container.dataset.page ?? '', 10);
            if (!Number.isSafeInteger(pageNumber) || pageNumber <= 0) {
                return null;
            }
            const row = container.closest<HTMLElement>(FACING_ROW_SELECTOR);
            const editorLayer = container.querySelector<HTMLElement>('[data-pdf-annotation-editor-surface]');
            return {
                pageNumber,
                rect: toRect(container.getBoundingClientRect()),
                rendered: container.classList.contains('page_container--rendered'),
                rowRect: row ? toRect(row.getBoundingClientRect()) : null,
                viewRotation: Number.parseInt(editorLayer?.dataset.viewRotation ?? '0', 10) || 0,
            };
        })
        .filter((page): page is IViewerInvariantPage => page !== null)
        .sort((left, right) => left.pageNumber - right.pageNumber);
}

function readOverlays(host: HTMLElement): IViewerInvariantOverlay[] {
    return [...host.querySelectorAll<HTMLElement>(ANNOTATION_ENTITY_SELECTOR)]
        .map((entity): IViewerInvariantOverlay | null => {
            const container = entity.closest<HTMLElement>(pdfViewerDomSelectors.pageContainer);
            const pageNumber = Number.parseInt(container?.dataset.page ?? '', 10);
            const annotationId = entity.dataset.annotationId ?? '';
            if (!annotationId || !Number.isSafeInteger(pageNumber) || pageNumber <= 0) {
                return null;
            }
            // The hit target is a deliberately fattened proxy, so geometry comes
            // from the visual pass whenever the entity draws one.
            const visual = entity.querySelector<HTMLElement>(ANNOTATION_VISUAL_SELECTOR) ?? entity;
            return {
                annotationId,
                kind: entity.dataset.annotationKind ?? 'unknown',
                outsidePage: entity.dataset.annotationOutsidePage !== undefined,
                pageNumber,
                rect: toRect(visual.getBoundingClientRect()),
                selected: entity.classList.contains('is-selected'),
                subtype: entity.dataset.markupSubtype ?? null,
            };
        })
        .filter((overlay): overlay is IViewerInvariantOverlay => overlay !== null);
}

function readNoteWindows(root: Document, host: HTMLElement): IViewerInvariantNoteWindow[] {
    return [...root.querySelectorAll<HTMLElement>(NOTE_WINDOW_SELECTOR)]
        .filter(isPaintedElement)
        .map((noteWindow): IViewerInvariantNoteWindow | null => {
            const annotationId = noteWindow.dataset.annotationId ?? '';
            if (!annotationId) {
                return null;
            }
            const anchorPageNumber = Number.parseInt(noteWindow.dataset.pageNumber ?? '', 10);
            const hasAnchorPage = Number.isSafeInteger(anchorPageNumber) && anchorPageNumber > 0;
            const anchorContainer = hasAnchorPage
                ? host.querySelector<HTMLElement>(
                    `${pdfViewerDomSelectors.pageContainer}[data-page="${String(anchorPageNumber)}"]:not(.page_container--buffered)`,
                )
                : null;
            return {
                anchorPageNumber: hasAnchorPage ? anchorPageNumber : null,
                anchorRect: anchorContainer ? toRect(anchorContainer.getBoundingClientRect()) : null,
                annotationId,
                rect: toRect(noteWindow.getBoundingClientRect()),
                userPlacementSequence: Number.parseInt(noteWindow.dataset.userPlacement ?? '0', 10) || 0,
            };
        })
        .filter((noteWindow): noteWindow is IViewerInvariantNoteWindow => noteWindow !== null);
}

function readChromeRects(root: Document, host: HTMLElement): IViewerChromeRect[] {
    const activePane = host.closest<HTMLElement>('.editor-pane');
    const surfaces: IViewerChromeRect[] = [];
    for (const selector of CHROME_SELECTORS) {
        for (const element of root.querySelectorAll<HTMLElement>(selector)) {
            if (isPaintedElement(element)) {
                surfaces.push({
                    name: selector,
                    rect: toRect(element.getBoundingClientRect()),
                });
            }
        }
    }
    for (const pane of root.querySelectorAll<HTMLElement>('.editor-pane')) {
        if (pane !== activePane && isPaintedElement(pane)) {
            surfaces.push({
                name: '.editor-pane (another pane)',
                rect: toRect(pane.getBoundingClientRect()),
            });
        }
    }
    return surfaces;
}

function parsePositiveInteger(value: string | null | undefined) {
    const parsed = Number.parseInt((value ?? '').replace(/[()\s]/gu, ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The page number as a reader sees it. The primary slot shows the logical page
 * label when the document has one and the physical number appears in the
 * secondary slot, so the physical number is taken from whichever slot renders
 * it rather than from the app's page state.
 */
function readToolbarPage(root: Document) {
    const toolbarHost = root.querySelector<HTMLElement>('#editor-global-toolbar-host') ?? root;
    const controls = [...toolbarHost.querySelectorAll<HTMLElement>(TOOLBAR_PAGE_CONTROLS_SELECTOR)]
        .find(isPaintedElement) ?? null;
    if (!controls) {
        return {
            toolbarPageNumber: null,
            toolbarPageText: null,
            toolbarTotalPages: null,
        };
    }
    const primaryText = controls.querySelector('.page-controls-current-primary')?.textContent?.trim() ?? '';
    const secondaryText = controls.querySelector('.page-controls-current-secondary')?.textContent?.trim() ?? '';
    return {
        toolbarPageNumber: parsePositiveInteger(secondaryText) ?? parsePositiveInteger(primaryText),
        toolbarPageText: secondaryText ? `${primaryText} ${secondaryText}` : primaryText,
        toolbarTotalPages: parsePositiveInteger(
            controls.querySelector('.page-controls-total')?.textContent,
        ),
    };
}

function readViewMode(value: string | undefined): TViewerViewMode {
    return value === 'facing' || value === 'facing-first-single' ? value : 'single';
}

function readZoomMode(value: string | undefined): TViewerZoomMode {
    return value === 'fit-width' || value === 'fit-height' ? value : 'custom';
}

export interface IViewerSurfaceReadResult {
    surface: IViewerSurface | null;
    unavailableReason: string | null;
}

/**
 * Reads the rendered viewer once. Pure DOM reads: no mutation, no layout
 * writes, and no app state beyond what the components publish on their own
 * elements.
 */
export function readViewerSurface(root: Document = document): IViewerSurfaceReadResult {
    const host = findActiveWorkspaceHost(root);
    if (!host) {
        return {
            surface: null,
            unavailableReason: 'no single painted workspace host is active',
        };
    }
    const viewport = host.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!isPaintedElement(viewport)) {
        return {
            surface: null,
            unavailableReason: 'the active workspace has no painted document viewport',
        };
    }
    const pageTrack = host.querySelector<HTMLElement>(PAGE_TRACK_SELECTOR);
    if (!pageTrack) {
        return {
            surface: null,
            unavailableReason: 'the active document viewport has no page track',
        };
    }

    return {
        surface: {
            chrome: readChromeRects(root, host),
            continuousScroll: pageTrack.dataset.pdfContinuousScroll !== 'false',
            horizontalScrollRangePx: Math.max(0, viewport.scrollWidth - viewport.clientWidth),
            noteWindows: readNoteWindows(root, host),
            overlays: readOverlays(host),
            pages: readPages(host),
            ...readToolbarPage(root),
            verticalScrollRangePx: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
            viewMode: readViewMode(pageTrack.dataset.pdfViewMode),
            viewportRect: readViewportRect(viewport),
            workspaceTabId: host.dataset.workspaceTabId ?? null,
            zoomMode: readZoomMode(pageTrack.dataset.pdfZoomMode),
        },
        unavailableReason: null,
    };
}
