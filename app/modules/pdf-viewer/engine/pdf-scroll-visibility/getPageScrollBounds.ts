import type {TPageNumber} from '@contracts/pageNumbers';

import {getPageContainerByNumber} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import type {IPageScrollBounds} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';

export function getPageScrollBounds(container: HTMLElement, pageNumber: TPageNumber, margin: number): IPageScrollBounds | null {
    const pageElement = getPageContainerByNumber(container, pageNumber);
    if (!pageElement) {
        return null;
    }

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const unclampedMin = Math.max(0, pageElement.offsetTop - margin);
    const unclampedMax = unclampedMin + Math.max(0, pageElement.offsetHeight - container.clientHeight);
    const min = Math.min(maxScrollTop, unclampedMin);
    const max = Math.min(maxScrollTop, Math.max(min, unclampedMax));

    return {
        min,
        max,
    };
}
