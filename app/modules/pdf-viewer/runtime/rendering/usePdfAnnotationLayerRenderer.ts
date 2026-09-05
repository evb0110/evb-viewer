import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { AnnotationLayer as TAnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import type { IPdfjsLinkService } from '@app/types/pdfjs';
import {
    createPdfjsAnnotationLayer,
    renderPdfjsAnnotationLayer,
} from '@app/services/pdfjs/pdfViewerFacade';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getShellCapability } from '@app/utils/getShellCapability';
import { normalizeAllowedExternalUrl } from '@contracts/externalUrl';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { IAnnotationLayerRenderOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfAnnotationLayerRendererTypes';

// fallow-ignore-next-line unused-type -- compatibility type remains until #195 removes the dormant renderer bridge.
export type { TAnnotationEditorLayerRenderResult } from '@app/modules/pdf-viewer/runtime/rendering/pdfAnnotationLayerRendererTypes';

// pdf.js parses a page's annotations once per document but re-serializes them,
// and re-extracts their text content, on every getAnnotations() call. The page
// proxy is replaced whenever the document is reloaded, so it is the exact
// lifetime of the parsed data.
const parsedPageAnnotations = new WeakMap<
    PDFPageProxy,
    ReturnType<PDFPageProxy['getAnnotations']>
>();

function getParsedPageAnnotations(pdfPage: PDFPageProxy) {
    const cached = parsedPageAnnotations.get(pdfPage);
    if (cached) {
        return cached;
    }

    const pending = pdfPage.getAnnotations().catch((error: unknown) => {
        parsedPageAnnotations.delete(pdfPage);
        throw error;
    });
    parsedPageAnnotations.set(pdfPage, pending);
    return pending;
}

function annotationIdOf(annotation: unknown) {
    if (!annotation || typeof annotation !== 'object') {
        return null;
    }
    const id = (annotation as {id?: unknown}).id;
    return typeof id === 'string' ? normalizePdfJsAnnotationId(id) : null;
}

function isLinkAnnotation(annotation: unknown) {
    if (!annotation || typeof annotation !== 'object') {
        return false;
    }
    const candidate = annotation as {
        annotationType?: unknown;
        subtype?: unknown;
    };
    return candidate.annotationType === 2
        || (typeof candidate.subtype === 'string' && candidate.subtype.toLowerCase() === 'link');
}

function normalizedIds(ids: ReadonlySet<string> | undefined) {
    const normalized = new Set<string>();
    ids?.forEach((id) => {
        const value = normalizePdfJsAnnotationId(id);
        if (value) {
            normalized.add(value);
        }
    });
    return normalized;
}

function createAnnotationLayerCancelledError(pageNumber: number) {
    const error = new Error(`Annotation layer render cancelled for page ${pageNumber}`);
    error.name = 'AbortError';
    return error;
}

async function raceWithAnnotationAbort<T>(
    promise: Promise<T>,
    pageNumber: number,
    options?: IAnnotationLayerRenderOptions,
) {
    const signal = options?.signal;
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        throw createAnnotationLayerCancelledError(pageNumber);
    }

    let removeAbortListener = () => {};
    const abortPromise = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(createAnnotationLayerCancelledError(pageNumber));
        signal.addEventListener('abort', abort, {once: true});
        removeAbortListener = () => signal.removeEventListener('abort', abort);
    });
    try {
        return await Promise.race([
            promise,
            abortPromise,
        ]);
    } finally {
        removeAbortListener();
    }
}

export const usePdfAnnotationLayerRenderer = (deps: {
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    annotationProjectionReady?: MaybeRefOrGetter<boolean>;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    getDocumentVersion?: (() => number) | undefined;
    scrollToPage?: (pageNumber: number) => void;
}) => {
    let annotationLayerRenderToken = 0;
    const annotationLayerPageRenderTokens = new Map<number, number>();

    function isDocumentVersionCurrent(options?: IAnnotationLayerRenderOptions) {
        return options?.documentVersion === undefined
            || deps.getDocumentVersion?.() === undefined
            || deps.getDocumentVersion() === options.documentVersion;
    }

    function shouldContinueLayerRender(options?: IAnnotationLayerRenderOptions) {
        return options?.signal?.aborted !== true
            && isDocumentVersionCurrent(options)
            && options?.shouldContinue?.() !== false;
    }

    function removeHiddenAnnotationElements(
        annotationLayerDiv: HTMLElement,
        hiddenIds: ReadonlySet<string>,
    ) {
        annotationLayerDiv.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
            const id = normalizePdfJsAnnotationId(
                element.dataset.annotationId ?? element.getAttribute('data-annotation-id'),
            );
            if (id && hiddenIds.has(id)) {
                element.remove();
            }
        });
    }

    async function renderAnnotationLayer(
        pdfPage: PDFPageProxy,
        annotationLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationCanvasMap?: Map<string, HTMLCanvasElement> | null,
        options?: IAnnotationLayerRenderOptions,
    ): Promise<TAnnotationLayer | null> {
        if (!shouldContinueLayerRender(options)) {
            return null;
        }

        const renderToken = ++annotationLayerRenderToken;
        annotationLayerPageRenderTokens.set(pageNumber, renderToken);

        const annotations = await raceWithAnnotationAbort(
            getParsedPageAnnotations(pdfPage),
            pageNumber,
            options,
        );
        if (
            annotationLayerPageRenderTokens.get(pageNumber) !== renderToken
            || !shouldContinueLayerRender(options)
        ) {
            return null;
        }

        const hiddenIds = normalizedIds(toValue(deps.hiddenAnnotationIds ?? new Set<string>()));
        const visibleAnnotations = hiddenIds.size === 0
            ? annotations
            : annotations.filter(annotation => !hiddenIds.has(annotationIdOf(annotation) ?? ''));
        // The writer parse is the authority for which PDF annotations the Vue
        // surface owns. Until it finishes, keep foreign links usable but do
        // not paint any other PDF.js annotation that may also be mounted by
        // the canonical surface on the next render pass.
        const projectionReady = toValue(deps.annotationProjectionReady ?? true);
        const renderableAnnotations = projectionReady
            ? visibleAnnotations
            : visibleAnnotations.filter(isLinkAnnotation);
        const simpleLinkService = {
            pagesCount: deps.numPages.value,
            page: deps.currentPage.value,
            rotation: viewport.rotation,
            isInPresentationMode: false,
            externalLinkEnabled: true,
            goToDestination: async () => {},
            goToPage: (page) => {
                if (typeof page === 'number') {
                    deps.scrollToPage?.(page);
                }
            },
            goToXY: () => {},
            addLinkAttributes: (
                link,
                url,
                _newWindow?: boolean,
            ) => {
                const openLink = () => {
                    const normalizedUrl = normalizeAllowedExternalUrl(url);
                    if (!normalizedUrl) {
                        BrowserLogger.warn('pdf-annotation-layer', `Blocked unsupported annotation link: ${url}`);
                        return;
                    }
                    void getShellCapability().openExternal(normalizedUrl).catch((error) => {
                        BrowserLogger.warn(
                            'pdf-annotation-layer',
                            `Failed to open annotation link: ${normalizedUrl}`,
                            error,
                        );
                    });
                };

                link.removeAttribute('href');
                link.removeAttribute('target');
                link.removeAttribute('rel');
                link.setAttribute('role', 'link');
                link.setAttribute('tabindex', '0');
                link.dataset.href = url;
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    openLink();
                });
                link.addEventListener('auxclick', event => event.preventDefault());
                link.addEventListener('contextmenu', event => event.preventDefault());
                link.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') {
                        return;
                    }
                    event.preventDefault();
                    openLink();
                });
            },
            getDestinationHash: () => '#',
            getAnchorUrl: () => '#',
            setHash: () => {},
            executeNamedAction: () => {},
            executeSetOCGState: () => {},
        } satisfies IPdfjsLinkService;

        const annotationLayer = createPdfjsAnnotationLayer({
            div: annotationLayerDiv as HTMLDivElement,
            page: pdfPage,
            viewport,
            annotationCanvasMap: annotationCanvasMap ?? null,
            annotationEditorUiManager: null,
            linkService: simpleLinkService,
        });
        if (!shouldContinueLayerRender(options)) {
            return null;
        }

        await raceWithAnnotationAbort(
            Promise.resolve(renderPdfjsAnnotationLayer(annotationLayer, {
                annotations: renderableAnnotations,
                viewport,
                div: annotationLayerDiv as HTMLDivElement,
                page: pdfPage,
                linkService: simpleLinkService,
                renderForms: false,
            })),
            pageNumber,
            options,
        );
        if (
            annotationLayerPageRenderTokens.get(pageNumber) !== renderToken
            || !shouldContinueLayerRender(options)
        ) {
            return null;
        }

        if (renderableAnnotations.length === 0) {
            annotationLayerDiv.innerHTML = '';
        }
        removeHiddenAnnotationElements(annotationLayerDiv, hiddenIds);
        return annotationLayer;
    }

    function clearAllLayers() {
        annotationLayerRenderToken += 1;
        annotationLayerPageRenderTokens.clear();
    }

    return {
        renderAnnotationLayer,
        clearAllLayers,
    };
};
