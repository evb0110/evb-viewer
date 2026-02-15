import {
    AnnotationLayer,
    AnnotationEditorLayer,
    AnnotationEditorType,
    DrawLayer,
} from 'pdfjs-dist';
import type {
    IL10n,
    IPDFLinkService,
} from 'pdfjs-dist/types/web/interfaces';
import type {
    PDFPageProxy,
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import {
    toValue,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue';
import { defaultDocument } from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browser-logger';

interface IAnnotationEditorLayerProto {
    disable?: (...args: unknown[]) => unknown;
    destroy?: (...args: unknown[]) => unknown;
    __evbSafetyPatchApplied?: boolean;
}

interface IPdfjsTextLayerElement extends HTMLDivElement {div: HTMLDivElement;}

let annotationEditorLayerSafetyPatched = false;
let destroyedEditorLayerFallbackDiv: HTMLDivElement | null = null;

function ensureAnnotationEditorLayerSafetyPatch() {
    if (annotationEditorLayerSafetyPatched) {
        return;
    }

    const proto = AnnotationEditorLayer.prototype as IAnnotationEditorLayerProto;
    if (!proto || proto.__evbSafetyPatchApplied) {
        annotationEditorLayerSafetyPatched = true;
        return;
    }

    const doc = defaultDocument;
    if (doc && !destroyedEditorLayerFallbackDiv) {
        destroyedEditorLayerFallbackDiv = doc.createElement('div');
        destroyedEditorLayerFallbackDiv.className =
            'annotation-editor-layer-destroyed-fallback';
        destroyedEditorLayerFallbackDiv.style.display = 'none';
        destroyedEditorLayerFallbackDiv.setAttribute('aria-hidden', 'true');
    }

    const originalDisable =
        typeof proto.disable === 'function' ? proto.disable : null;
    if (originalDisable) {
        proto.disable = function patchedDisable(
            this: { div?: HTMLElement | null },
            ...args: unknown[]
        ) {
            if (!this) {
                return undefined;
            }
            if (!this.div) {
                this.div = destroyedEditorLayerFallbackDiv;
            }
            return originalDisable.call(this, ...args);
        };
    }

    const originalDestroy =
        typeof proto.destroy === 'function' ? proto.destroy : null;
    if (originalDestroy) {
        proto.destroy = function patchedDestroy(
            this: { div?: HTMLElement | null },
            ...args: unknown[]
        ) {
            if (this?.div == null) {
                this.div = destroyedEditorLayerFallbackDiv;
            }
            const result = originalDestroy.call(this, ...args);
            if (this?.div == null) {
                this.div = destroyedEditorLayerFallbackDiv;
            }
            return result;
        };
    }

    proto.__evbSafetyPatchApplied = true;
    annotationEditorLayerSafetyPatched = true;
}

export const usePdfAnnotationLayerRenderer = (deps: {
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    annotationUiManager: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n: MaybeRefOrGetter<IL10n | null>;
    scrollToPage?: (pageNumber: number) => void;
}) => {
    ensureAnnotationEditorLayerSafetyPatch();

    const annotationEditorLayers = new Map<number, AnnotationEditorLayer>();
    const drawLayers = new Map<number, DrawLayer>();
    const annotationEditorLayerDisabledDocuments =
        new WeakSet<PDFDocumentProxy>();
    let annotationEditorLayerDisabledWithoutDocument = false;
    let activeEditorDocument: PDFDocumentProxy | null = deps.pdfDocument.value;
    const fallbackL10n: IL10n = {
        getLanguage: () => 'en',
        getDirection: () => 'ltr',
        get: (ids, _args, fallback) => {
            if (typeof fallback === 'string') {
                return Promise.resolve(fallback);
            }
            if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string') {
                return Promise.resolve(ids[0]);
            }
            return Promise.resolve(typeof ids === 'string' ? ids : '');
        },
        translate: () => Promise.resolve(),
        pause: () => {},
        resume: () => {},
    };

    function toPdfjsTextLayerRef(
        textLayerDiv: HTMLDivElement | null,
    ): IPdfjsTextLayerElement | undefined {
        if (!textLayerDiv) {
            return undefined;
        }

        const normalizedTextLayer = textLayerDiv as IPdfjsTextLayerElement;
        try {
            normalizedTextLayer.div = textLayerDiv;
        } catch {
            // Ignore: in that case we'll fall back to a lightweight shim.
        }

        if (normalizedTextLayer.div === textLayerDiv) {
            return normalizedTextLayer;
        }

        return { div: textLayerDiv } as IPdfjsTextLayerElement;
    }

    function syncEditorLayersWithCurrentDocument() {
        const currentDocument = deps.pdfDocument.value;
        if (currentDocument === activeEditorDocument) {
            return;
        }
        activeEditorDocument = currentDocument;
        clearAllLayers();
    }

    function isAnnotationEditorLayerDisabledForCurrentDocument() {
        const currentDocument = deps.pdfDocument.value;
        if (currentDocument) {
            return annotationEditorLayerDisabledDocuments.has(currentDocument);
        }
        return annotationEditorLayerDisabledWithoutDocument;
    }

    function disableAnnotationEditorLayerForCurrentDocument(
        error: unknown,
        pageNumber: number,
    ) {
        const currentDocument = deps.pdfDocument.value;
        if (currentDocument) {
            if (!annotationEditorLayerDisabledDocuments.has(currentDocument)) {
                BrowserLogger.warn(
                    'pdf-annotation-layer',
                    `Disabling annotation editor layer for current document after page ${pageNumber} failure`,
                    error,
                );
            }
            annotationEditorLayerDisabledDocuments.add(currentDocument);
        } else {
            if (!annotationEditorLayerDisabledWithoutDocument) {
                BrowserLogger.warn(
                    'pdf-annotation-layer',
                    `Disabling annotation editor layer without active document after page ${pageNumber} failure`,
                    error,
                );
            }
            annotationEditorLayerDisabledWithoutDocument = true;
        }
        clearAllLayers();
    }

    async function renderAnnotationLayer(
        pdfPage: PDFPageProxy,
        annotationLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        _pageNumber: number,
    ) {
        annotationLayerDiv.innerHTML = '';

        const annotations = await pdfPage.getAnnotations();
        const annotationStorage = deps.pdfDocument.value?.annotationStorage;
        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;

        const simpleLinkService = {
            pagesCount: deps.numPages.value,
            page: deps.currentPage.value,
            rotation: 0,
            isInPresentationMode: false,
            externalLinkEnabled: true,
            goToDestination: async () => {},
            goToPage: (page: number) => deps.scrollToPage?.(page),
            goToXY: () => {},
            addLinkAttributes: (
                link: HTMLAnchorElement,
                url: string,
                newWindow?: boolean,
            ) => {
                link.href = url;
                if (newWindow) {
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                }
            },
            getDestinationHash: () => '#',
            getAnchorUrl: () => '#',
            setHash: () => {},
            executeNamedAction: () => {},
            executeSetOCGState: () => {},
        } as IPDFLinkService;

        const annotationLayerInstance = new AnnotationLayer({
            div: annotationLayerDiv as HTMLDivElement,
            page: pdfPage,
            viewport,
            accessibilityManager: null,
            annotationCanvasMap: null,
            annotationEditorUIManager: annotationUiManager,
            structTreeLayer: null,
            commentManager: null,
            linkService: simpleLinkService,
            annotationStorage,
        });

        await annotationLayerInstance.render({
            annotations,
            viewport,
            div: annotationLayerDiv as HTMLDivElement,
            page: pdfPage,
            linkService: simpleLinkService,
            renderForms: false,
            annotationStorage,
        });

        return annotationLayerInstance;
    }

    function renderAnnotationEditorLayer(
        container: HTMLElement,
        annotationEditorLayerDiv: HTMLElement,
        textLayerDiv: HTMLDivElement | null,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationLayerInstance: AnnotationLayer | null,
    ) {
        syncEditorLayersWithCurrentDocument();

        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
        if (
            !annotationUiManager ||
      isAnnotationEditorLayerDisabledForCurrentDocument()
        ) {
            annotationEditorLayerDiv.innerHTML = '';
            annotationEditorLayerDiv.hidden = true;
            return false;
        }

        try {
            const editorViewport = viewport.clone({ dontFlip: true });
            const editorLayer = annotationEditorLayers.get(pageNumber);
            const drawLayer =
                drawLayers.get(pageNumber) ??
        new DrawLayer({ pageIndex: pageNumber - 1 });

            const canvasHost =
                container.querySelector<HTMLDivElement>('.page_canvas');
            if (canvasHost) {
                drawLayer.setParent(canvasHost);
            }
            drawLayers.set(pageNumber, drawLayer);

            if (!editorLayer) {
                annotationEditorLayerDiv.innerHTML = '';
                annotationEditorLayerDiv.dir = annotationUiManager.direction;
            }

            const l10n = toValue(deps.annotationL10n) ?? fallbackL10n;
            const textLayerRef = toPdfjsTextLayerRef(textLayerDiv);
            const activeLayer =
                editorLayer ??
        new AnnotationEditorLayer({
            mode: {},
            uiManager: annotationUiManager,
            div: annotationEditorLayerDiv as HTMLDivElement,
            structTreeLayer: null,
            enabled: true,
            accessibilityManager: undefined,
            pageIndex: pageNumber - 1,
            l10n,
            viewport: editorViewport,
            annotationLayer: annotationLayerInstance ?? undefined,
            // pdfjs-dist type declarations lag runtime shape; runtime expects a textLayer carrying a `div` reference.
            textLayer: textLayerRef,
            drawLayer,
        });

            if (!editorLayer) {
                annotationEditorLayers.set(pageNumber, activeLayer);
            }

            if (editorLayer) {
                editorLayer.update({ viewport: editorViewport });
            } else {
                activeLayer.render({ viewport: editorViewport });
            }

            const currentMode =
                typeof annotationUiManager.getMode === 'function'
                    ? annotationUiManager.getMode()
                    : AnnotationEditorType.NONE;
            const shouldHideLayer =
                currentMode === AnnotationEditorType.NONE && activeLayer.isInvisible;

            annotationEditorLayerDiv.hidden = shouldHideLayer;
            activeLayer.pause(shouldHideLayer);
            return true;
        } catch (error) {
            disableAnnotationEditorLayerForCurrentDocument(error, pageNumber);
            annotationEditorLayerDiv.innerHTML = '';
            annotationEditorLayerDiv.hidden = true;
            return false;
        }
    }

    function cleanupEditorLayer(pageNumber: number) {
        const editorLayer = annotationEditorLayers.get(pageNumber);
        if (editorLayer) {
            try {
                editorLayer.destroy();
            } catch (error) {
                BrowserLogger.debug(
                    'pdf-annotation-layer',
                    'Failed to destroy annotation editor layer',
                    error,
                );
            }
            annotationEditorLayers.delete(pageNumber);
        }

        const drawLayer = drawLayers.get(pageNumber);
        if (drawLayer) {
            drawLayer.destroy();
            drawLayers.delete(pageNumber);
        }
    }

    function clearAllLayers() {
        for (const pageNumber of [...annotationEditorLayers.keys()]) {
            cleanupEditorLayer(pageNumber);
        }
        for (const [
            pageNumber,
            drawLayer,
        ] of drawLayers) {
            try {
                drawLayer.destroy();
            } catch (error) {
                BrowserLogger.debug(
                    'pdf-annotation-layer',
                    `Failed to destroy draw layer for page ${pageNumber}`,
                    error,
                );
            }
        }
        drawLayers.clear();
    }

    return {
        renderAnnotationLayer,
        renderAnnotationEditorLayer,
        cleanupEditorLayer,
        clearAllLayers,
    };
};
