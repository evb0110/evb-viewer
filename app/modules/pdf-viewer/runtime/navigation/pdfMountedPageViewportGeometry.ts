import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import {clamp} from 'es-toolkit/math';
import {
    resolveScrollForPageRect,
    type IPdfSemanticAnchor,
} from '@app/modules/document-viewer/public';
import {getRequestAnchor} from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';

function getMountedPageElement(container: HTMLElement, pageNumber: TPageNumber) {
    return container.querySelector<HTMLElement>(
        `.page_container[data-page="${String(Math.max(1, Math.trunc(pageNumber)))}"]`,
    );
}

export function hasMeasurableMountedPage(container: HTMLElement, pageNumber: TPageNumber) {
    const rect = getMountedPageElement(container, pageNumber)?.getBoundingClientRect();
    return rect !== undefined && rect.width > 0 && rect.height > 0;
}

export function resolvePagedAnchorFromViewport(
    container: HTMLElement,
    pageNumber: TPageNumber,
    viewportFraction = {
        x: 0.5,
        y: 0.5,
    },
): IPdfSemanticAnchor {
    const page = requirePageNumber(Math.max(1, Math.trunc(pageNumber)));
    const element = getMountedPageElement(container, page);
    if (!element) {
        return getRequestAnchor(undefined, page);
    }
    const viewportRect = container.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    const x = viewportRect.left + container.clientWidth * viewportFraction.x;
    const y = viewportRect.top + container.clientHeight * viewportFraction.y;
    return {
        page,
        pageXFraction: clamp((x - pageRect.left) / Math.max(1, pageRect.width), 0, 1),
        pageYFraction: clamp((y - pageRect.top) / Math.max(1, pageRect.height), 0, 1),
        viewportXFraction: clamp(viewportFraction.x, 0, 1),
        viewportYFraction: clamp(viewportFraction.y, 0, 1),
        affinity: 'center',
    };
}

export function resolvePagedScrollForAnchor(
    container: HTMLElement,
    anchor: IPdfSemanticAnchor,
    scaledMargin: number,
) {
    const element = getMountedPageElement(container, requirePageNumber(anchor.page));
    if (!element) {
        return {
            left: container.scrollLeft,
            top: container.scrollTop,
        };
    }
    const viewportRect = container.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    return resolveScrollForPageRect({
        left: container.scrollLeft + pageRect.left - viewportRect.left,
        top: container.scrollTop + pageRect.top - viewportRect.top,
        width: pageRect.width,
        height: pageRect.height,
    }, anchor, {
        width: container.clientWidth,
        height: container.clientHeight,
    }, {
        width: container.scrollWidth,
        height: container.scrollHeight,
    }, scaledMargin);
}
