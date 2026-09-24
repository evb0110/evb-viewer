import pdfjsRuntime, {
    AnnotationLayer,
    TextLayer,
} from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager as TAnnotationEditorUIManager } from 'pdfjs-dist';
import type { AnnotationLayer as TAnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer';
import type {IPdfjsLinkService} from '@app/types/pdfjs';
import type {
    IPdfAnnotation,
    IPdfPage,
    IPdfTextContent,
    IPdfViewport,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

export interface ICreatePdfjsAnnotationLayerOptions {
    div: HTMLDivElement;
    page: IPdfPage;
    viewport: IPdfViewport;
    annotationCanvasMap?: Map<string, HTMLCanvasElement> | null | undefined;
    annotationEditorUiManager: TAnnotationEditorUIManager | null;
    linkService: IPdfjsLinkService;
    annotationStorage?: unknown;
}

export interface IRenderPdfjsAnnotationLayerOptions {
    annotations: readonly IPdfAnnotation[];
    div: HTMLDivElement;
    page: IPdfPage;
    viewport: IPdfViewport;
    linkService: IPdfjsLinkService;
    annotationStorage?: unknown;
    renderForms: boolean;
}


export interface ICreatePdfjsTextLayerOptions {
    textContentSource: IPdfTextContent | ReadableStream;
    container: HTMLElement;
    viewport: IPdfViewport;
}

export interface IPdfTextLayer {
    render(): Promise<unknown>;
    update(options: {viewport: IPdfViewport}): void;
    cancel(): void;
    readonly textDivs: HTMLElement[];
    readonly textContentItemsStr: string[];
}

export interface IPdfStructTreeLayer {
    render(): Promise<unknown>;
    updateTextLayer(): void;
}






export function createPdfjsAnnotationLayer(options: ICreatePdfjsAnnotationLayerOptions) {
    return new AnnotationLayer({
        div: options.div,
        page: options.page,
        viewport: options.viewport,
        accessibilityManager: null,
        annotationCanvasMap: options.annotationCanvasMap ?? null,
        annotationEditorUIManager: options.annotationEditorUiManager,
        structTreeLayer: null,
        commentManager: null,
        linkService: options.linkService as never,
        annotationStorage: options.annotationStorage,
    });
}

export function renderPdfjsAnnotationLayer(
    layer: TAnnotationLayer,
    options: IRenderPdfjsAnnotationLayerOptions,
) {
    return layer.render({
        annotations: options.annotations as never,
        viewport: options.viewport,
        div: options.div,
        page: options.page as never,
        linkService: options.linkService as never,
        renderForms: options.renderForms,
        annotationStorage: options.annotationStorage as never,
    });
}



export function createPdfjsTextLayer(options: ICreatePdfjsTextLayerOptions): IPdfTextLayer {
    return new TextLayer(
        options as ConstructorParameters<typeof TextLayer>[0],
    );
}

export async function createPdfjsStructTreeLayer(options: {
    page: IPdfPage;
    rawDims: object;
}): Promise<IPdfStructTreeLayer> {
    (globalThis as typeof globalThis & {pdfjsLib?: typeof pdfjsRuntime}).pdfjsLib ??= pdfjsRuntime;
    const { StructTreeLayerBuilder } = await import('pdfjs-dist/web/pdf_viewer.mjs');
    return new StructTreeLayerBuilder(options.page, options.rawDims);
}




