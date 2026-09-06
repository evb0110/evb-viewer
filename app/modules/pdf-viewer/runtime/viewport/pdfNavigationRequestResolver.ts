import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type {
    IPdfNavigationRequest,
    TPdfNavigationTarget,
} from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import {
    createTextLayerRangeForSearchMatch,
    createTextLayerRangeForSearchOccurrence,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import { resolveBookmarkDestinationTarget } from '@app/utils/pdfOutlineHelpers';

export interface IResolvedPdfNavigationTarget {
    page: number;
    rect: IAnnotationMarkerRect | null;
}

function rangeMatchesSearchText(range: Range | null, text: string, matchCase: boolean) {
    if (!range) {
        return false;
    }
    const rangeText = range.toString().normalize('NFC');
    const targetText = text.normalize('NFC');
    return matchCase
        ? rangeText === targetText
        : rangeText.toLocaleLowerCase() === targetText.toLocaleLowerCase();
}

function normalizedPointRect(top: number): IAnnotationMarkerRect {
    return {
        left: 0.5,
        top: clamp(top, 0, 1),
        width: 0,
        height: 0,
    };
}

export async function resolvePdfNavigationTarget(
    target: TPdfNavigationTarget,
    pdfDocument: IPdfDocument | null,
): Promise<IResolvedPdfNavigationTarget> {
    if (target.kind === 'page') {
        return {
            page: target.page,
            rect: null,
        };
    }
    if (target.kind === 'rect') {
        return {
            page: target.page,
            rect: target.rect,
        };
    }
    if (target.kind === 'text-anchor') {
        return {
            page: target.page,
            rect: null,
        };
    }
    if (!pdfDocument) throw new DOMException('Named destination requires a PDF document', 'AbortError');
    const destination = await resolveBookmarkDestinationTarget(pdfDocument, target.destination);
    if (!destination) throw new DOMException('Named destination could not be resolved', 'AbortError');
    return {
        page: destination.page,
        rect: typeof destination.pageYRatio === 'number'
            ? normalizedPointRect(destination.pageYRatio)
            : null,
    };
}

export function resolvePdfNavigationAnchor(
    request: IPdfNavigationRequest,
    target: IResolvedPdfNavigationTarget,
): IPdfSemanticAnchor {
    const rect = target.rect;
    if (request.alignment === 'rect-center' && rect) {
        return {
            page: target.page,
            pageXFraction: clamp(rect.left + rect.width / 2, 0, 1),
            pageYFraction: clamp(rect.top + rect.height / 2, 0, 1),
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        };
    }
    return {
        page: target.page,
        pageXFraction: 0.5,
        pageYFraction: rect ? clamp(rect.top, 0, 1) : 0,
        viewportXFraction: 0.5,
        viewportYFraction: 0,
        affinity: 'start',
    };
}

export function resolveTextAnchorRect(
    container: HTMLElement,
    target: Extract<TPdfNavigationTarget, {kind: 'text-anchor'}>,
): IAnnotationMarkerRect | null {
    const page = container.querySelector<HTMLElement>(`.page_container[data-page="${target.page}"]`);
    const textLayer = page?.querySelector<HTMLElement>('.text-layer, .textLayer');
    if (!page || !textLayer) {
        return null;
    }
    const spans = Array.from(textLayer.querySelectorAll<HTMLElement>('span'));
    if (target.searchRange) {
        const exactRange = createTextLayerRangeForSearchMatch(textLayer, target.searchRange);
        const matchCase = target.searchOptions?.matchCase ?? false;
        const pageLocalRange = Number.isSafeInteger(target.pageMatchIndex)
            && Number.isSafeInteger(target.expectedPageMatchCount)
            ? createTextLayerRangeForSearchOccurrence(textLayer, target)
            : null;
        const range = pageLocalRange && rangeMatchesSearchText(pageLocalRange, target.text, matchCase)
            ? pageLocalRange
            : rangeMatchesSearchText(exactRange, target.text, matchCase)
                ? exactRange
                : createTextLayerRangeForSearchOccurrence(textLayer, {
                    text: target.text,
                    pageMatchIndex: target.pageMatchIndex,
                    searchQuery: target.searchQuery,
                    searchOptions: target.searchOptions,
                });
        const rects = range
            ? Array.from(range.getClientRects?.() ?? []).filter(rect => rect.width > 0 || rect.height > 0)
            : [];
        const rect = rects.length > 0
            ? {
                left: Math.min(...rects.map(item => item.left)),
                top: Math.min(...rects.map(item => item.top)),
                right: Math.max(...rects.map(item => item.right)),
                bottom: Math.max(...rects.map(item => item.bottom)),
                width: Math.max(...rects.map(item => item.right)) - Math.min(...rects.map(item => item.left)),
                height: Math.max(...rects.map(item => item.bottom)) - Math.min(...rects.map(item => item.top)),
            }
            : range?.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
            const pageRect = page.getBoundingClientRect();
            if (pageRect.width > 0 && pageRect.height > 0) {
                return {
                    left: clamp((rect.left - pageRect.left) / pageRect.width, 0, 1),
                    top: clamp((rect.top - pageRect.top) / pageRect.height, 0, 1),
                    width: clamp(rect.width / pageRect.width, 0, 1),
                    height: clamp(rect.height / pageRect.height, 0, 1),
                };
            }
        }
        // A canonical range and page-local occurrence are the only reliable
        // identities for a search result. If neither maps, keep page-level
        // navigation rather than jumping to the first duplicate span.
        return null;
    }
    const needle = `${target.prefix ?? ''}${target.text}${target.suffix ?? ''}`.normalize('NFKC');
    const matchingSpan = spans.find((span) => {
        const value = (span.textContent ?? '').normalize('NFKC');
        return value.includes(needle) || value.includes(target.text.normalize('NFKC'));
    });
    if (!matchingSpan) {
        return null;
    }
    const pageRect = page.getBoundingClientRect();
    const rect = matchingSpan.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    return {
        left: clamp((rect.left - pageRect.left) / pageRect.width, 0, 1),
        top: clamp((rect.top - pageRect.top) / pageRect.height, 0, 1),
        width: clamp(rect.width / pageRect.width, 0, 1),
        height: clamp(rect.height / pageRect.height, 0, 1),
    };
}

export function isPdfNavigationReady(
    container: HTMLElement,
    page: number,
    readiness: IPdfNavigationRequest['readiness'],
    isCanvasFresh: (page: number) => boolean,
) {
    if (readiness === 'metrics') {
        return true;
    }
    if (!isCanvasFresh(page)) {
        return false;
    }
    if (readiness === 'page-canvas') {
        return true;
    }
    const pageElement = container.querySelector<HTMLElement>(`.page_container[data-page="${page}"]`);
    if (readiness === 'text-layer') {
        const textLayer = pageElement?.querySelector<HTMLElement>('.text-layer, .textLayer');
        return textLayer?.dataset?.pdfTextLayerReady === 'true';
    }
    return Boolean(pageElement?.querySelector(
        '.pdf-annotation-editor-layer, .annotation-editor-layer, .annotationEditorLayer',
    ));
}
