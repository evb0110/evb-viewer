export interface IPageBoundedHorizontalScrollInput {
    scrollLeft: number;
    viewportWidth: number;
    pageLeft: number;
    pageWidth: number;
    margin: number;
    epsilon?: number;
}

export interface IRenderedSpreadHorizontalBounds {
    left: number;
    width: number;
}
