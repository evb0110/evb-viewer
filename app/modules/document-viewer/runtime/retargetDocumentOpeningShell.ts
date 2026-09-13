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
    readonly sourceRevisionKey?: string;
    readonly style: Readonly<Record<string, string>>;
    readonly preview?: IDocumentOpenSurfacePagePreview;
}

export interface IDocumentOpenSurfacePagePreview {
    readonly documentId: string;
    readonly documentRevision: string;
    readonly pageNumber: number;
    readonly sourceRevisionKey: string;
    readonly objectUrl: string;
    readonly renderedWidth: number;
}

export interface IDocumentOpenSurfacePageGeometry {
    readonly documentId: string;
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: number;
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
            : visual.openingPageFrame.preview
                // Retain both the old page number and its pixels until the
                // replacement preview commits them together. Relabeling the
                // retained frame would make stale pixels claim the new page.
                ? visual.openingPageFrame
                : Object.freeze({
                    ...visual.openingPageFrame,
                    pageNumber,
                }),
        committedViewportPosition: null,
    };
}
