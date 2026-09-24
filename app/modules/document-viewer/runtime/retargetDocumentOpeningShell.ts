export type TDocumentOpenSurfacePresentation = 'idle' | 'page-shell'
    | 'committed' | 'failed';
export type TDocumentOpenSurfaceVisualPresentation = Exclude<TDocumentOpenSurfacePresentation, 'failed'>;

export interface IDocumentOpenSurfaceGeometry {
    readonly width: number;
    readonly height: number;
    readonly margin: number;
}

export interface IDocumentOpenSurfacePageFrame {
    readonly generation: number;
    readonly ownerId: string;
    readonly pageNumber: number;
    readonly intentKey: string;
    readonly style: Readonly<Record<string, string>>;
}

export interface IDocumentOpenSurfacePageGeometry {
    readonly documentId: string;
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: number;
    /** Widest displayed page width, when the source reports its document-wide Fit Width. */
    readonly widestPageWidth?: number;
    readonly size?: number;
    readonly modifiedAt?: number;
}

export interface IDocumentOpenSurfaceVisualState {
    presentation: TDocumentOpenSurfaceVisualPresentation;
    geometry: IDocumentOpenSurfaceGeometry | null;
    openingPageGeometry: IDocumentOpenSurfacePageGeometry | null;
    openingPageFrame: IDocumentOpenSurfacePageFrame | null;
    committedViewportPosition: {
        readonly viewportIntentId: string;
        readonly left: number;
        readonly top: number;
    } | null;
}

export function retargetDocumentOpeningShell<TVisual extends IDocumentOpenSurfaceVisualState>(
    visual: TVisual,
    pageNumber: number,
): TVisual {
    return {
        ...visual,
        presentation: 'page-shell',
        openingPageGeometry: visual.openingPageGeometry === null
            ? null
            : Object.freeze({
                ...visual.openingPageGeometry,
                pageNumber,
            }),
        openingPageFrame: visual.openingPageFrame === null
            ? null
            : Object.freeze({
                ...visual.openingPageFrame,
                pageNumber,
            }),
        committedViewportPosition: null,
    };
}
