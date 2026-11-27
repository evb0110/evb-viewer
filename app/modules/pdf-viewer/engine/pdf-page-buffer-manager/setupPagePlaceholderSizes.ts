import {parsePageNumber} from '@contracts/pageNumbers';
import type {TPageNumber} from '@contracts/pageNumbers';

import type {IPdfPageMetric} from '@app/types/pdfUi';
import {buildPdfPageScaleStyle, createPdfPageScale} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

const placeholderSizeCache = new WeakMap<
    HTMLElement,
    {
        width: number;
        height: number;
    }
>();

function setStyleProperty(style: CSSStyleDeclaration, property: string, value: string) {
    if (typeof style.setProperty === 'function') {
        style.setProperty(property, value);
        return;
    }

    // Some renderer unit tests intentionally use a minimal HTMLElement double.
    // Keep this pure geometry helper compatible with those doubles without
    // weakening the browser path, where CSSStyleDeclaration#setProperty exists.
    Reflect.set(style, property, value);
}

export function setupPagePlaceholderSizes(
    containerRoot: HTMLElement,
    pageMetrics: IPdfPageMetric[],
    scale: number,
    getScaleForPage: ((pageNumber: TPageNumber) => number) | undefined = undefined,
) {
    const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');
    containers.forEach((container) => {
        const parsedPageNumber = Number.parseInt(container.dataset.page ?? '', 10);
        const pageNumber = parsePageNumber(parsedPageNumber);
        if (pageNumber === null) {
            return;
        }
        const metric = pageMetrics[pageNumber - 1];
        if (!metric) {
            return;
        }

        const pageScale = getScaleForPage?.(pageNumber) ?? scale;
        const width = metric.width * pageScale;
        const height = metric.height * pageScale;
        const scaleStyle = buildPdfPageScaleStyle(createPdfPageScale(pageScale, metric.userUnit));
        Object.entries(scaleStyle).forEach(([property, value]) => {
            setStyleProperty(container.style, property, value);
        });
        const cached = placeholderSizeCache.get(container);
        if (cached && Math.abs(cached.width - width) < 0.25 && Math.abs(cached.height - height) < 0.25) {
            return;
        }
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
        placeholderSizeCache.set(container, {
            width,
            height,
        });
    });
}
