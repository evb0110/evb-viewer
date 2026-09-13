import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/public';

export function diagnosePdfPageSkeletonGeometry(
    chassisAuthority: IDocumentViewerRuntime,
    viewerContainer: Readonly<Ref<HTMLElement | null>>,
    currentPage: Readonly<Ref<number>>,
    scaledMargin: Readonly<Ref<number>>,
    pageNumber: TPageNumber,
    options: {
        authoritativePageNumber?: number;
        expectedGeneration?: number;
        minimumScrollHeight?: number | null;
        requireVisibleSkeleton?: boolean;
    } = {},
) {
    const authoritativePageNumber = options.authoritativePageNumber ?? currentPage.value;
    if (pageNumber !== authoritativePageNumber) {
        return {
            canCommit: false,
            reason: 'page-not-current',
        } as const;
    }
    const surface = chassisAuthority.openSurface;
    const snapshot = surface.snapshot.value;
    if (
        snapshot.phase !== 'pending'
        || snapshot.geometry !== null
        || options.expectedGeneration !== undefined && snapshot.generation !== options.expectedGeneration
        || pageNumber !== authoritativePageNumber
    ) {
        return {
            canCommit: false,
            reason: 'surface-not-pending',
        } as const;
    }
    const container = viewerContainer.value;
    const requireVisibleSkeleton = options.requireVisibleSkeleton !== false;
    if (requireVisibleSkeleton && options.minimumScrollHeight === null) {
        return {
            canCommit: false,
            reason: 'virtual-extent-unresolved',
        } as const;
    }
    const minimumScrollHeight = Math.max(0, options.minimumScrollHeight ?? 0);
    if (
        !container
        || requireVisibleSkeleton && container.scrollHeight < minimumScrollHeight
    ) {
        return {
            canCommit: false,
            reason: !container ? 'viewer-container-missing' : 'virtual-extent-too-small',
        } as const;
    }
    const pageContainer = container.querySelector<HTMLElement>(
        `.page_container[data-page="${String(pageNumber)}"]`,
    ) ?? null;
    const pageSkeleton = pageContainer?.querySelector<HTMLElement>('.document-page-skeleton') ?? null;
    if (
        !pageContainer?.isConnected
        || requireVisibleSkeleton && !pageSkeleton?.isConnected
    ) {
        return {
            canCommit: false,
            reason: !pageContainer?.isConnected ? 'page-container-disconnected' : 'skeleton-disconnected',
        } as const;
    }
    const canvas = requireVisibleSkeleton
        ? null
        : pageContainer.querySelector<HTMLCanvasElement>('.page_canvas canvas');
    if (
        !requireVisibleSkeleton
        && (
            !canvas?.isConnected
            || canvas.width <= 0
            || canvas.height <= 0
        )
    ) {
        return {
            canCommit: false,
            reason: 'canvas-not-ready',
        } as const;
    }
    const skeletonStyle = pageSkeleton ? window.getComputedStyle(pageSkeleton) : null;
    const rect = pageContainer.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect() ?? null;
    if (
        requireVisibleSkeleton && skeletonStyle?.display === 'none'
        || requireVisibleSkeleton && skeletonStyle?.visibility === 'hidden'
        || rect.width <= 0
        || rect.height <= 0
        || canvasRect !== null && (canvasRect.width <= 0 || canvasRect.height <= 0)
    ) {
        return {
            canCommit: false,
            reason: 'page-layout-not-visible',
        } as const;
    }
    return {
        canCommit: true,
        reason: 'ready',
        geometry: {
            width: rect.width,
            height: rect.height,
            margin: scaledMargin.value,
        },
    } as const;
}

export function commitPdfPageSkeletonGeometry(
    chassisAuthority: IDocumentViewerRuntime,
    viewerContainer: Readonly<Ref<HTMLElement | null>>,
    currentPage: Readonly<Ref<number>>,
    scaledMargin: Readonly<Ref<number>>,
    pageNumber: TPageNumber,
    options: {
        authoritativePageNumber?: number;
        expectedGeneration?: number;
        minimumScrollHeight?: number | null;
        requireVisibleSkeleton?: boolean;
    } = {},
) {
    const diagnostic = diagnosePdfPageSkeletonGeometry(
        chassisAuthority,
        viewerContainer,
        currentPage,
        scaledMargin,
        pageNumber,
        options,
    );
    if (!diagnostic.canCommit) {
        return false;
    }
    return chassisAuthority.openSurface.commitGeometry(
        chassisAuthority.openSurface.snapshot.value.generation,
        diagnostic.geometry,
    );
}
