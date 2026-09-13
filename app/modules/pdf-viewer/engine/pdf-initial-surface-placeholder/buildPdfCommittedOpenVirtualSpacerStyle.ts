import { parsePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { TPdfViewMode } from '@app/types/pdfContracts';
import {
    hasCommittedDocumentOpeningLayout,
    isDocumentOpenEmptySurfaceTransition,
    type IDocumentOpenSurfaceSnapshot,
} from '@app/modules/document-viewer/public';

function readPositivePixels(value: string | undefined) {
    if (!value?.endsWith('px')) {
        return null;
    }
    const number = Number.parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function resolveUniformPageRowIndex(pageNumber: TPageNumber, viewMode: TPdfViewMode) {
    if (viewMode === 'single') {
        return pageNumber - 1;
    }
    if (viewMode === 'facing') {
        return Math.floor((pageNumber - 1) / 2);
    }
    return pageNumber === 1 ? 0 : 1 + Math.floor((pageNumber - 2) / 2);
}

function resolveUniformPageRowCount(pageCount: number, viewMode: TPdfViewMode) {
    if (viewMode === 'single') {
        return pageCount;
    }
    if (viewMode === 'facing') {
        return Math.ceil(pageCount / 2);
    }
    return 1 + Math.ceil((pageCount - 1) / 2);
}

function resolvePdfCommittedOpenVirtualSpacerHeight(input: {
    snapshot: IDocumentOpenSurfaceSnapshot;
    continuousScroll: boolean;
    viewMode: TPdfViewMode;
    gap: number;
    lastMountedPage: number;
}) {
    if (!input.continuousScroll || !hasCommittedDocumentOpeningLayout(input.snapshot)) {
        return null;
    }

    const geometry = input.snapshot.openingPageGeometry;
    const frame = input.snapshot.openingPageFrame;
    if (!geometry || !frame || input.lastMountedPage >= geometry.pageCount) {
        return null;
    }

    const width = readPositivePixels(frame.style.width);
    const height = readPositivePixels(frame.style.height);
    if (width === null || height === null) {
        return null;
    }

    const pageNumber = parsePageNumber(Math.min(geometry.pageCount, Math.floor(input.lastMountedPage)), geometry.pageCount);
    if (pageNumber === null) {
        return null;
    }
    const hiddenRows = Math.max(
        0,
        resolveUniformPageRowCount(geometry.pageCount, input.viewMode)
        - resolveUniformPageRowIndex(pageNumber, input.viewMode)
        - 1,
    );
    if (hiddenRows === 0) {
        return null;
    }
    const gap = Number.isFinite(input.gap) ? Math.max(0, input.gap) : 0;
    return hiddenRows * height + Math.max(0, hiddenRows - 1) * gap;
}

export function buildPdfCommittedOpenVirtualSpacerStyle(input: {
    snapshot: IDocumentOpenSurfaceSnapshot;
    continuousScroll: boolean;
    viewMode: TPdfViewMode;
    gap: number;
    lastMountedPage: number;
}) {
    const spacerHeight = resolvePdfCommittedOpenVirtualSpacerHeight(input);
    if (spacerHeight === null) {
        return null;
    }
    const value = `${String(spacerHeight)}px`;
    return {
        height: value,
        minHeight: value,
        flexBasis: value,
    };
}

export function resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight(input: {
    snapshot: IDocumentOpenSurfaceSnapshot;
    continuousScroll: boolean;
    viewMode: TPdfViewMode;
    gap: number;
}) {
    if (!input.continuousScroll) {
        return 0;
    }
    if (
        isDocumentOpenEmptySurfaceTransition(input.snapshot)
        && input.snapshot.openingPageFrame !== null
        && input.snapshot.openingPageGeometry === null
    ) {
        return null;
    }
    if (!hasCommittedDocumentOpeningLayout(input.snapshot)) {
        return 0;
    }
    const geometry = input.snapshot.openingPageGeometry;
    if (!geometry || geometry.pageCount <= geometry.pageNumber) {
        return 0;
    }
    return resolvePdfCommittedOpenVirtualSpacerHeight({
        ...input,
        lastMountedPage: geometry.pageNumber,
    });
}
