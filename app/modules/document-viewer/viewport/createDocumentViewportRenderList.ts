import { clamp } from 'es-toolkit/math';
import {
    createAnchorFirstPageOrder,
    type IDocumentViewerPageRange,
    normalizeDocumentViewerPageRange,
    type TDocumentViewerPageDirection,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';

type TDocumentViewportScrollDirection = TDocumentViewerPageDirection;

interface ICreateDocumentViewportRenderListOptions {
    anchorPage: number;
    direction?: TDocumentViewportScrollDirection | undefined;
    directionalPrefetchPages?: number | undefined;
    endPage: number;
    prefetchPages: number;
    startPage: number;
    totalPages: number;
}

function normalizeNonNegativeInteger(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.trunc(value);
}

function resolveDirectionalRange(options: ICreateDocumentViewportRenderListOptions): IDocumentViewerPageRange {
    const totalPages = Math.max(0, Math.trunc(options.totalPages));
    if (totalPages <= 0) {
        return {
            start: 1,
            end: 0,
        };
    }

    const baseRange = normalizeDocumentViewerPageRange({
        startPage: options.startPage,
        endPage: options.endPage,
        totalPages,
    });
    const behindPages = normalizeNonNegativeInteger(options.prefetchPages);
    const aheadPages = normalizeNonNegativeInteger(options.directionalPrefetchPages);
    if (aheadPages <= behindPages || options.direction === undefined || options.direction === 0) {
        return normalizeDocumentViewerPageRange({
            startPage: options.startPage,
            endPage: options.endPage,
            totalPages,
            paddingPages: options.prefetchPages,
        });
    }

    return {
        start: clamp(
            baseRange.start - (options.direction === -1 ? aheadPages : behindPages),
            1,
            totalPages,
        ),
        end: clamp(
            baseRange.end + (options.direction === 1 ? aheadPages : behindPages),
            1,
            totalPages,
        ),
    };
}

export function createDocumentViewportRenderList(options: ICreateDocumentViewportRenderListOptions) {
    const range = resolveDirectionalRange(options);

    return createAnchorFirstPageOrder({
        range,
        anchorPage: options.anchorPage,
        ...(options.direction === undefined ? {} : { direction: options.direction }),
    });
}
