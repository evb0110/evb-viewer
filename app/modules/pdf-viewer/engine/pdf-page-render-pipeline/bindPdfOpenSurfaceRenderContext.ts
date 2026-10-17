import type {
    IPdfPage,
    IPdfDocument,
    IPdfAnnotation,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {TPdfPageOperationSettlementCapture} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import type {NativeAnnotationAppearance} from 'pdfjs-dist';

/** Immutable inputs of the actual render, retained by its committed page slot. */
export interface IPdfAnnotationRenderInput {
    readonly document: IPdfDocument;
    readonly original: IPdfAnnotationParseResult | null;
    readonly annotations: readonly IPdfAnnotation[];
    readonly semanticInputs: ReadonlyArray<Readonly<{
        id?: string;
        ref: string | null;
        fingerprint: string
    }>>;
    readonly excludedIds: ReadonlySet<string>;
    readonly signature: string;
    readonly nativeAnnotationAppearance?: NativeAnnotationAppearance;
    readonly nativeTextBoxInputs?: ReadonlyArray<Readonly<{
        id: string;
        key: string;
        appearanceIndex: number;
        appearanceDocument: number
    }>>;
}

export type TPdfPageRenderContentIntent =
    | 'full-visible'
    | 'canvas-only-buffer'
    | 'canvas-only-refine'
    | 'layers-only-promotion';

export interface IRenderVisiblePagesOptions {
    annotationCommit?: {
        signature: string;
        prepare(page: IPdfPage, captureSettlement: TPdfPageOperationSettlementCapture, signal: AbortSignal, reserveAppearanceBytes: (bytes: number) => void): Promise<IPdfAnnotationRenderInput>;
        isCurrent(): boolean;
        commit(): void;
    };
    authoritativeRaster?: boolean;
    openSurfaceGeneration?: number;
    openSurfaceRevision?: string;
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    renderWindowOverride?: {
        start: number;
        end: number;
    };
    forceRerender?: boolean;
    suppressResidentRasterDemand?: boolean;
    retainOnlyCurrentResidentRaster?: boolean;
    prioritizeTextLayer?: boolean;
    contentIntent?: TPdfPageRenderContentIntent;
    maxCanvasPixels?: number;
    rasterDemandPages?: readonly number[];
    bufferMaxCanvasPixels?: number;
}

export type TPdfOpenSurfaceRenderContext = Pick<
    Required<IRenderVisiblePagesOptions>,
    'openSurfaceGeneration' | 'openSurfaceRevision'
>;

export function bindPdfOpenSurfaceRenderContext(
    renderOptions: IRenderVisiblePagesOptions | undefined,
    context: TPdfOpenSurfaceRenderContext | undefined,
) {
    return context
        ? {
            ...renderOptions,
            ...context,
        }
        : renderOptions;
}
