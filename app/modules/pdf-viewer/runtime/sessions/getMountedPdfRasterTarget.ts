import { pageNumberToPageIndex } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';

export function getMountedPdfRasterTarget(root: HTMLElement | null, pageNumber: TPageNumber) {
    const container = root ? getPageContainer(root, pageNumberToPageIndex(pageNumber)) : null;
    const canvasHost = container?.querySelector<HTMLDivElement>('.page_canvas__render-layer') ?? null;
    return container && canvasHost ? {
        container,
        canvasHost,
        detailHost: container.querySelector<HTMLDivElement>('.page_canvas__detail-layer'),
    } : null;
}
