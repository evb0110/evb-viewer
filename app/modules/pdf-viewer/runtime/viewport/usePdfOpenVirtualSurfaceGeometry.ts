import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/public';
import {
    buildPdfCommittedOpenVirtualSpacerStyle,
    resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight,
} from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/buildPdfCommittedOpenVirtualSpacerStyle';

interface IUsePdfOpenVirtualSurfaceGeometryOptions<TSpacerStyle, TPlaceholderStyle> {
    chassisAuthority: IDocumentViewerRuntime | null;
    continuousScroll: Readonly<Ref<boolean>>;
    viewMode: Readonly<Ref<TPdfViewMode>>;
    scaledMargin: Readonly<Ref<number>>;
    virtualizedBottomVirtualSpacerStyle: Readonly<Ref<TSpacerStyle>>;
    getLastMountedPage: () => number | undefined;
    viewerContainer: Readonly<Ref<HTMLElement | null>>;
    zoomMode: Readonly<Ref<string>>;
    hasExactPageGeometry: (pageNumber: TPageNumber) => boolean;
    isFitWidthScaleCurrent: (container: HTMLElement, options: { page: number }) => boolean;
    getPagePlaceholderStyle: (pageNumber: TPageNumber) => TPlaceholderStyle;
}

export const usePdfOpenVirtualSurfaceGeometry = <TSpacerStyle, TPlaceholderStyle>(
    options: IUsePdfOpenVirtualSurfaceGeometryOptions<TSpacerStyle, TPlaceholderStyle>,
) => {
    const bottomVirtualSpacerStyle = computed(() => {
        const snapshot = options.chassisAuthority?.openSurface.snapshot.value;
        if (!snapshot) {
            return options.virtualizedBottomVirtualSpacerStyle.value;
        }
        const lastMountedPage = options.getLastMountedPage()
            ?? snapshot.openingPageFrame?.pageNumber
            ?? 1;
        return buildPdfCommittedOpenVirtualSpacerStyle({
            snapshot,
            continuousScroll: options.continuousScroll.value,
            viewMode: options.viewMode.value,
            gap: options.scaledMargin.value,
            lastMountedPage,
        }) ?? options.virtualizedBottomVirtualSpacerStyle.value;
    });
    const openingVirtualExtentMinimumScrollHeight = computed(() => {
        const snapshot = options.chassisAuthority?.openSurface.snapshot.value;
        if (!snapshot) {
            return 0;
        }
        return resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight({
            snapshot,
            continuousScroll: options.continuousScroll.value,
            viewMode: options.viewMode.value,
            gap: options.scaledMargin.value,
        });
    });

    function getExactPagePlaceholderStyle(pageNumber: TPageNumber) {
        const fitViewport = options.viewerContainer.value;
        if (
            !options.hasExactPageGeometry(pageNumber)
            || options.zoomMode.value !== 'custom'
                && (
                    !fitViewport
                    || fitViewport.clientWidth <= 0
                    || fitViewport.clientHeight <= 0
                    || !options.isFitWidthScaleCurrent(fitViewport, { page: pageNumber })
                )
        ) {
            return null;
        }
        return options.getPagePlaceholderStyle(pageNumber);
    }

    return {
        bottomVirtualSpacerStyle,
        openingVirtualExtentMinimumScrollHeight,
        getExactPagePlaceholderStyle,
    };
};
