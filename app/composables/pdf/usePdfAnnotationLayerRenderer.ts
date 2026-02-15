import {
    AnnotationLayer,
    AnnotationEditorLayer,
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
import { BrowserLogger } from '@app/utils/browser-logger';

type TAnnotationEditorLayerProto = {
    disable?: (...args: unknown[]) => unknown;
    destroy?: (...args: unknown[]) => unknown;
    __evbSafetyPatchApplied?: boolean;
};

let annotationEditorLayerSafetyPatched = false;
let destroyedEditorLayerFallbackDiv: HTMLDivElement | null = null;
let textLayerFallbackDiv: HTMLDivElement | null = null;

function ensureAnnotationEditorLayerSafetyPatch() {
    if (annotationEditorLayerSafetyPatched) {
        return;
    }

    const proto = AnnotationEditorLayer.prototype as TAnnotationEditorLayerProto;
    if (!proto || proto.__evbSafetyPatchApplied) {
        annotationEditorLayerSafetyPatched = true;
        return;
    }

    if (typeof document !== 'undefined') {
        if (!destroyedEditorLayerFallbackDiv) {
            destroyedEditorLayerFallbackDiv = document.createElement('div');
            destroyedEditorLayerFallbackDiv.className = 'annotation-editor-layer-destroyed-fallback';
            destroyedEditorLayerFallbackDiv.style.display = 'none';
            destroyedEditorLayerFallbackDiv.setAttribute('aria-hidden', 'true');
        }
        if (!textLayerFallbackDiv) {
            textLayerFallbackDiv = document.createElement('div');
            textLayerFallbackDiv.className = 'annotation-editor-layer-text-fallback';
            textLayerFallbackDiv.style.display = 'none';
            textLayerFallbackDiv.setAttribute('aria-hidden', 'true');
        }
    }

    const originalDisable = typeof proto.disable === 'function'
        ? proto.disable
        : null;
    if (originalDisable) {
        proto.disable = function patchedDisable(
            this: {
                div?: HTMLElement | null;
                textLayer?: { div?: HTMLElement | null } | null;
            },
            ...args: unknown[]
        ) {
            if (!this) {
                return undefined;
            }
            if (!this.div) {
                this.div = destroyedEditorLayerFallbackDiv;
            }
            if (this.textLayer && !this.textLayer.div) {
                this.textLayer.div = textLayerFallbackDiv;
            }
            return originalDisable.call(this, ...args);
        };
    }

    const originalDestroy = typeof proto.destroy === 'function'
        ? proto.destroy
        : null;
    if (originalDestroy) {
        proto.destroy = function patchedDestroy(
            this: {
                div?: HTMLElement | null;
                textLayer?: { div?: HTMLElement | null } | null;
            },
            ...args: unknown[]
        ) {
            if (this?.div == null) {
                this.div = destroyedEditorLayerFallbackDiv;
            }
            const result = originalDestroy.call(this, ...args);
            if (this?.div == null) {
                this.div = destroyedEditorLayerFallbackDiv;
            }
            if (this?.textLayer && !this.textLayer.div) {
                this.textLayer.div = textLayerFallbackDiv;
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
        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
        if (!annotationUiManager) {
            return;
        }

        const editorViewport = viewport.clone({ dontFlip: true });
        const editorLayer = annotationEditorLayers.get(pageNumber);
        const drawLayer = drawLayers.get(pageNumber) ?? new DrawLayer({ pageIndex: pageNumber - 1 });

        const canvasHost = container.querySelector<HTMLDivElement>('.page_canvas');
        if (canvasHost) {
            drawLayer.setParent(canvasHost);
        }
        drawLayers.set(pageNumber, drawLayer);

        if (!editorLayer) {
            annotationEditorLayerDiv.innerHTML = '';
            annotationEditorLayerDiv.dir = annotationUiManager.direction;
        }

        const l10n = toValue(deps.annotationL10n) ?? fallbackL10n;
        const activeLayer = editorLayer ?? new AnnotationEditorLayer({
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
            textLayer: textLayerDiv ?? undefined,
            drawLayer,
        });

        if (!editorLayer) {
            annotationUiManager.addLayer(activeLayer);
            annotationEditorLayers.set(pageNumber, activeLayer);
        }

        if (editorLayer) {
            editorLayer.update({ viewport: editorViewport });
        } else {
            activeLayer.render({ viewport: editorViewport });
        }

        annotationEditorLayerDiv.hidden = activeLayer.isInvisible;
        activeLayer.pause(false);
    }

    function cleanupEditorLayer(pageNumber: number) {
        const editorLayer = annotationEditorLayers.get(pageNumber);
        if (editorLayer) {
            const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
            try {
                annotationUiManager?.removeLayer?.(editorLayer);
            } catch (error) {
                BrowserLogger.debug('pdf-annotation-layer', 'Failed to detach editor layer from UI manager', error);
            }
            editorLayer.destroy();
            annotationEditorLayers.delete(pageNumber);
        }

        const drawLayer = drawLayers.get(pageNumber);
        if (drawLayer) {
            drawLayer.destroy();
            drawLayers.delete(pageNumber);
        }
    }

    function clearAllLayers() {
        annotationEditorLayers.clear();
        drawLayers.clear();
    }

    return {
        renderAnnotationLayer,
        renderAnnotationEditorLayer,
        cleanupEditorLayer,
        clearAllLayers,
    };
};
