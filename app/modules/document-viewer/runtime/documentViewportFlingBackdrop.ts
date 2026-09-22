/**
 * Page geometry a renderer publishes so the chassis can draw page shells
 * behind its scroll viewport during a fling.
 *
 * On macOS the compositor scrolls trackpad momentum on its own thread. A fast
 * fling reaches content that has not been rasterized yet, and the compositor
 * draws such tiles in the viewport's background. The chassis therefore keeps
 * the viewport transparent and paints a repeating row of page shells behind
 * it, moved by a scroll timeline so it follows the scroll without new raster.
 */
export interface IDocumentViewportFlingBackdropPage {
    readonly width: number;
    readonly height: number;
}

export interface IDocumentViewportFlingBackdrop {
    /** Pages of one row, left to right. */
    readonly pages: readonly IDocumentViewportFlingBackdropPage[];
    /** Horizontal gap between the pages of a row. */
    readonly columnGap: number;
    /** Distance between the tops of consecutive rows. */
    readonly pitch: number;
    /** Top of any row in the viewport's scroll-content coordinates. */
    readonly rowTop: number;
}
