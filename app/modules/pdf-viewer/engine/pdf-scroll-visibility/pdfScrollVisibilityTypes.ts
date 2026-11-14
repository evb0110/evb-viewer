import type { TPageNumber } from '@contracts/pageNumbers';



export interface IVisiblePageRange {
    start: TPageNumber;
    end: TPageNumber;
}

export interface IViewportVisibilityResult {
    range: IVisiblePageRange | null;
    mostVisiblePage: TPageNumber | null;
}

export interface IPageScrollBounds {
    min: number;
    max: number;
}
