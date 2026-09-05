import type {
    IGeometryResolution,
    IPagePointResolutionSelection,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/pdfPagePointResolverTypes';
import type { Ref } from 'vue';
import type { IPagePointTarget } from '@app/modules/pdf-viewer/engine/annotations/pagePointTarget';
import { BrowserLogger } from '@app/utils/browserLogger';
import { buildPagePointTargetFromContainer } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/buildPagePointTargetFromContainer';
import type { INotePlacementDiagnosticsContext } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/notePlacementDiagnosticsContext';
import { scanPageGeometryCandidates } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/scanPageGeometryCandidates';
import { selectPagePointResolution } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/selectPagePointResolution';

const NOTE_PLACEMENT_LOG_SECTION = 'note-placement';

const MAX_PAGE_CANDIDATE_LOG_ENTRIES = 14;




interface IPagePointPageNumbers {
    byTargetPage: number | null;
    byElementFromPointPage: number | null;
    byGeometryPage: number | null;
}

interface IPdfPagePointResolverOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
}

function roundForLog(value: number, digits = 3) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function parsePageNumberFromContainer(pageContainer: HTMLElement | null) {
    if (!pageContainer?.dataset.page) {
        return null;
    }
    const parsed = Number(pageContainer.dataset.page);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function createEmptyGeometryResolution(collectCandidates: boolean): IGeometryResolution {
    return {
        pageContainer: null,
        source: 'none',
        candidates: collectCandidates ? [] : null,
    };
}

export function createPdfPagePointResolver(options: IPdfPagePointResolverOptions) {
    const {
        viewerContainer,
        currentPage,
    } = options;

    function summarizeElementForLog(element: HTMLElement | null) {
        if (!element) {
            return null;
        }
        return {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            classList: Array.from(element.classList).slice(0, 8),
            dataPage: parsePageNumberFromContainer(element.closest<HTMLElement>('.page_container')),
            role: element.getAttribute('role'),
        };
    }

    function summarizeVisiblePageWindowForLog() {
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }
        const viewportTop = container.scrollTop;
        const viewportBottom = viewportTop + container.clientHeight;
        const visiblePages: number[] = [];
        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');
        for (const pageContainer of pageContainers) {
            const pageNumber = parsePageNumberFromContainer(pageContainer);
            if (!pageNumber) {
                continue;
            }
            const pageTop = pageContainer.offsetTop;
            const pageBottom = pageTop + pageContainer.offsetHeight;
            if (pageBottom < viewportTop || pageTop > viewportBottom) {
                continue;
            }
            visiblePages.push(pageNumber);
        }
        return {
            start: visiblePages[0] ?? null,
            end: visiblePages.at(-1) ?? null,
            count: visiblePages.length,
            sample: visiblePages.slice(0, MAX_PAGE_CANDIDATE_LOG_ENTRIES),
            viewportTop: roundForLog(viewportTop),
            viewportBottom: roundForLog(viewportBottom),
        };
    }

    function resolvePageContainerByGeometry(
        clientX: number,
        clientY: number,
        resolverOptions: { collectCandidates?: boolean } = {},
    ): IGeometryResolution {
        const collectCandidates = resolverOptions.collectCandidates ?? false;
        const container = viewerContainer.value;
        if (!container) {
            return createEmptyGeometryResolution(collectCandidates);
        }
        const pages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'));
        if (pages.length === 0) {
            return createEmptyGeometryResolution(collectCandidates);
        }

        return scanPageGeometryCandidates(pages, clientX, clientY, collectCandidates)
            ?? createEmptyGeometryResolution(collectCandidates);
    }

    function findPageContainerFromClientPoint(clientX: number, clientY: number) {
        return resolvePageContainerByGeometry(clientX, clientY).pageContainer;
    }

    function resolvePageContainerFromTarget(targetElement?: HTMLElement | null) {
        const container = viewerContainer.value;
        if (!container || !targetElement) {
            return null;
        }
        const pageContainer = targetElement.closest<HTMLElement>('.page_container');
        if (!pageContainer) {
            return null;
        }
        if (!container.contains(pageContainer)) {
            const targetPageNumber = parsePageNumberFromContainer(pageContainer);
            if (!targetPageNumber) {
                return null;
            }
            const matchingPage = Array.from(container.querySelectorAll<HTMLElement>('.page_container'))
                .find(page => parsePageNumberFromContainer(page) === targetPageNumber)
                ?? null;
            return matchingPage;
        }
        return pageContainer;
    }

    function resolvePageContainerFromDocumentPoint(clientX: number, clientY: number) {
        const container = viewerContainer.value;
        if (!container || typeof document === 'undefined') {
            return {
                pointElement: null,
                pageContainer: null,
            };
        }
        const pointElement = document.elementFromPoint(clientX, clientY);
        if (!(pointElement instanceof HTMLElement)) {
            return {
                pointElement: null,
                pageContainer: null,
            };
        }
        const pageContainer = pointElement.closest<HTMLElement>('.page_container');
        if (!pageContainer || !container.contains(pageContainer)) {
            return {
                pointElement,
                pageContainer: null,
            };
        }
        return {
            pointElement,
            pageContainer,
        };
    }

    function logPagePointConflict(
        diagnostics: INotePlacementDiagnosticsContext,
        targetElement: HTMLElement | null,
        pointElement: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        selection: IPagePointResolutionSelection,
        pageNumbers: IPagePointPageNumbers,
    ) {
        const viewer = viewerContainer.value;
        BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page target conflict detected', {
            attemptId: diagnostics.attemptId ?? null,
            source: diagnostics.source ?? null,
            selectedSource: selection.selectedSource,
            byTargetPage: pageNumbers.byTargetPage,
            byElementFromPointPage: pageNumbers.byElementFromPointPage,
            byGeometryPage: pageNumbers.byGeometryPage,
            targetConflictsWithElementPoint: selection.targetConflictsWithElementPoint,
            targetConflictsWithGeometry: selection.targetConflictsWithGeometry,
            clickTarget: summarizeElementForLog(targetElement),
            pointElement: summarizeElementForLog(pointElement),
            renderedPageCandidates: geometryResolution.candidates,
            visiblePageWindow: summarizeVisiblePageWindowForLog(),
            viewerScrollTop: viewer?.scrollTop ?? null,
            viewerScrollLeft: viewer?.scrollLeft ?? null,
            clickMeta: diagnostics.clickMeta ?? null,
        });
    }

    function logPagePointResolutionFailure(
        diagnostics: INotePlacementDiagnosticsContext,
        clientX: number,
        clientY: number,
        targetElement: HTMLElement | null,
        pointElement: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        selection: IPagePointResolutionSelection,
        pageNumbers: IPagePointPageNumbers,
    ) {
        BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Failed to resolve quick-note page container', {
            attemptId: diagnostics.attemptId ?? null,
            source: diagnostics.source ?? null,
            clientX: roundForLog(clientX),
            clientY: roundForLog(clientY),
            currentPage: currentPage.value,
            byTargetPage: pageNumbers.byTargetPage,
            byElementFromPointPage: pageNumbers.byElementFromPointPage,
            byGeometryPage: pageNumbers.byGeometryPage,
            selectedSource: selection.selectedSource,
            clickTarget: summarizeElementForLog(targetElement),
            pointElement: summarizeElementForLog(pointElement),
            renderedPageCandidates: geometryResolution.candidates,
            visiblePageWindow: summarizeVisiblePageWindowForLog(),
            clickMeta: diagnostics.clickMeta ?? null,
        });
    }

    function resolvePagePointTarget(
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnostics?: INotePlacementDiagnosticsContext,
    ): IPagePointTarget | null {
        const targetPageContainer = resolvePageContainerFromTarget(targetElement);
        const documentPointResolution = resolvePageContainerFromDocumentPoint(clientX, clientY);
        const geometryResolution = resolvePageContainerByGeometry(clientX, clientY, {collectCandidates: Boolean(diagnostics)});
        const pageNumbers: IPagePointPageNumbers = {
            byTargetPage: parsePageNumberFromContainer(targetPageContainer),
            byElementFromPointPage: parsePageNumberFromContainer(documentPointResolution.pageContainer),
            byGeometryPage: parsePageNumberFromContainer(geometryResolution.pageContainer),
        };

        const selection = selectPagePointResolution({
            targetPageContainer,
            documentPointContainer: documentPointResolution.pageContainer,
            geometryResolution,
            ...pageNumbers,
        });

        if (diagnostics && selection.hasTargetConflict) {
            logPagePointConflict(
                diagnostics,
                targetElement ?? null,
                documentPointResolution.pointElement,
                geometryResolution,
                selection,
                pageNumbers,
            );
        }

        if (!selection.pageContainer) {
            if (diagnostics) {
                logPagePointResolutionFailure(
                    diagnostics,
                    clientX,
                    clientY,
                    targetElement ?? null,
                    documentPointResolution.pointElement,
                    geometryResolution,
                    selection,
                    pageNumbers,
                );
            }
            return null;
        }

        return buildPagePointTargetFromContainer(
            selection.pageContainer,
            clientX,
            clientY,
            selection.selectedSource,
            currentPage.value,
            diagnostics,
        );
    }

    return {
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
    };
}
