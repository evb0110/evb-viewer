import {
    AnnotationEditorParamsType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    colorWithOpacity,
    rectIoU,
    rectCenterDistance,
} from '@app/composables/pdf/pdfAnnotationUtils';

export const TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>> = {
    underline: 'Underline',
    strikethrough: 'StrikeOut',
};

const MARKUP_EDITOR_CLASS_PREFIX = 'pdf-markup-subtype-';
const MARKUP_DRAW_LAYER_CLASS_PREFIX = 'pdf-markup-subtype-draw-';

interface IUseAnnotationMarkupSubtypeOptions {
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationSettings: Ref<IAnnotationSettings | null>;
    numPages: Ref<number>;
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
}

export function useAnnotationMarkupSubtype(options: IUseAnnotationMarkupSubtypeOptions) {
    const {
        annotationUiManager,
        annotationSettings,
        numPages,
        getEditorIdentity,
    } = options;

    const markupSubtypeOverrides = new Map<string, TMarkupSubtype>();
    const editorMarkupSubtypeOverrides = new Map<string, TMarkupSubtype>();
    const editorObjectMarkupSubtypeOverrides = new WeakMap<IPdfjsEditor, TMarkupSubtype>();
    const editorDrawLayerHighlightRefs = new WeakMap<IPdfjsEditor, SVGElement>();

    function resolveMarkupSubtypeColor(subtype: TMarkupSubtype) {
        const settings = annotationSettings.value;
        if (subtype === 'Underline') {
            return settings?.underlineColor ?? '#2563eb';
        }
        if (subtype === 'StrikeOut') {
            return settings?.strikethroughColor ?? '#dc2626';
        }
        return settings?.highlightColor ?? '#ffd400';
    }

    function resolveEditorHighlightClipPathId(editor: IPdfjsEditor) {
        const internal = editor.div?.querySelector<HTMLElement>('.internal');
        if (!internal) {
            return null;
        }

        const clipPath = internal.style.clipPath || getComputedStyle(internal).clipPath;
        const clipMatch = /#([A-Za-z0-9_-]+)/.exec(clipPath);
        return clipMatch?.[1] ?? null;
    }

    function findClosestHighlightDrawLayerSvg(pageContainer: HTMLElement, editorDiv: HTMLElement) {
        const editorRect = editorDiv.getBoundingClientRect();
        if (editorRect.width <= 0 || editorRect.height <= 0) {
            return null;
        }

        const candidates = Array.from(pageContainer.querySelectorAll<SVGElement>('svg.highlight'));
        let bestOverlap: {
            score: number;
            svg: SVGElement;
        } | null = null;
        let bestDistance: {
            distance: number;
            svg: SVGElement;
        } | null = null;

        for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }
            const overlapScore = rectIoU(editorRect, rect);
            if (overlapScore > 0) {
                if (!bestOverlap || overlapScore > bestOverlap.score) {
                    bestOverlap = {
                        score: overlapScore,
                        svg: candidate,
                    };
                }
                continue;
            }

            const distance = rectCenterDistance(editorRect, rect);
            if (!bestDistance || distance < bestDistance.distance) {
                bestDistance = {
                    distance,
                    svg: candidate,
                };
            }
        }

        if (bestOverlap) {
            return bestOverlap.svg;
        }
        if (bestDistance && bestDistance.distance <= 40) {
            return bestDistance.svg;
        }
        return null;
    }

    function resolveEditorDrawLayerHighlight(editor: IPdfjsEditor) {
        const cached = editorDrawLayerHighlightRefs.get(editor);
        if (cached?.isConnected) {
            return cached;
        }

        const pageContainer = editor.div?.closest<HTMLElement>('.page_container');
        if (!pageContainer) {
            return null;
        }

        const clipPathId = resolveEditorHighlightClipPathId(editor);
        if (!clipPathId) {
            return null;
        }

        const escapedClipPathId = clipPathId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        const clipPathNode = pageContainer.querySelector<SVGElement>(
            `svg.highlight clipPath[id="${escapedClipPathId}"]`,
        );
        let highlightSvg = clipPathNode?.closest<SVGElement>('svg.highlight') ?? null;
        if (!highlightSvg && editor.div) {
            highlightSvg = findClosestHighlightDrawLayerSvg(pageContainer, editor.div);
        }
        if (highlightSvg) {
            editorDrawLayerHighlightRefs.set(editor, highlightSvg);
        }
        return highlightSvg;
    }

    function clearMarkupSubtypeDrawLayerClass(editor: IPdfjsEditor) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return;
        }

        highlightSvg.classList.remove(
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}underline`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}strikeout`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}squiggly`,
        );
        highlightSvg.style.removeProperty('--pdf-markup-subtype-color');
    }

    function applyMarkupSubtypeDrawLayerClass(editor: IPdfjsEditor, subtype: TMarkupSubtype | null, attempt = 0) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            if (attempt < 18 && editor.div?.isConnected) {
                setTimeout(() => {
                    applyMarkupSubtypeDrawLayerClass(editor, subtype, attempt + 1);
                }, 50);
            }
            return;
        }

        clearMarkupSubtypeDrawLayerClass(editor);
        if (!subtype || subtype === 'Highlight') {
            return;
        }

        highlightSvg.classList.add(`${MARKUP_DRAW_LAYER_CLASS_PREFIX}${subtype.toLowerCase()}`);
        highlightSvg.style.setProperty('--pdf-markup-subtype-color', resolveMarkupSubtypeColor(subtype));
    }

    function clearMarkupSubtypeEditorClass(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            clearMarkupSubtypeDrawLayerClass(editor);
            return;
        }
        div.classList.remove(
            `${MARKUP_EDITOR_CLASS_PREFIX}highlight`,
            `${MARKUP_EDITOR_CLASS_PREFIX}underline`,
            `${MARKUP_EDITOR_CLASS_PREFIX}strikeout`,
            `${MARKUP_EDITOR_CLASS_PREFIX}squiggly`,
        );
        delete div.dataset.markupSubtype;
        div.style.removeProperty('--pdf-markup-subtype-color');
        clearMarkupSubtypeDrawLayerClass(editor);
    }

    function applyEditorMarkupSubtypePresentation(editor: IPdfjsEditor, subtype: TMarkupSubtype | null) {
        clearMarkupSubtypeEditorClass(editor);
        applyMarkupSubtypeDrawLayerClass(editor, subtype);

        const div = editor.div;
        if (!div) {
            return;
        }

        if (!subtype || subtype === 'Highlight') {
            return;
        }

        const normalizedSubtype = subtype.toLowerCase();
        div.classList.add(`${MARKUP_EDITOR_CLASS_PREFIX}${normalizedSubtype}`);
        div.dataset.markupSubtype = normalizedSubtype;
        div.style.setProperty('--pdf-markup-subtype-color', resolveMarkupSubtypeColor(subtype));
    }

    function resolveEditorSubtypeFromPresentation(editor: IPdfjsEditor): TMarkupSubtype | null {
        const div = editor.div;
        if (!div) {
            return null;
        }
        const explicit = div.dataset.markupSubtype?.trim().toLowerCase() ?? '';
        if (explicit === 'underline') {
            return 'Underline';
        }
        if (explicit === 'strikeout' || explicit === 'strikethrough') {
            return 'StrikeOut';
        }
        if (explicit === 'squiggly') {
            return 'Squiggly';
        }
        if (explicit === 'highlight') {
            return 'Highlight';
        }

        const classList = Array.from(div.classList);
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}underline`))) {
            return 'Underline';
        }
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}strikeout`))) {
            return 'StrikeOut';
        }
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}squiggly`))) {
            return 'Squiggly';
        }
        return null;
    }

    function syncMarkupSubtypePresentationForEditors() {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return;
        }

        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const normalizedEditor = editor as IPdfjsEditor;
                const subtype = (
                    resolveEditorMarkupSubtypeOverride(normalizedEditor, pageIndex)
                    ?? resolveEditorSubtypeFromPresentation(normalizedEditor)
                );
                applyEditorMarkupSubtypePresentation(normalizedEditor, subtype);
            }
        }
    }

    function setEditorMarkupSubtypeOverride(editor: IPdfjsEditor, pageIndex: number, subtype: TMarkupSubtype) {
        editorObjectMarkupSubtypeOverrides.set(editor, subtype);
        const identity = getEditorIdentity(editor, pageIndex);
        editorMarkupSubtypeOverrides.set(identity, subtype);
        if (editor.annotationElementId) {
            markupSubtypeOverrides.set(editor.annotationElementId, subtype);
        }
        applyEditorMarkupSubtypePresentation(editor, subtype);
    }

    function resolveEditorMarkupSubtypeOverride(editor: IPdfjsEditor, pageIndex: number): TMarkupSubtype | null {
        const byObject = editorObjectMarkupSubtypeOverrides.get(editor);
        if (byObject) {
            return byObject;
        }
        if (editor.annotationElementId) {
            const byAnnotationId = markupSubtypeOverrides.get(editor.annotationElementId);
            if (byAnnotationId) {
                return byAnnotationId;
            }
        }
        const identity = getEditorIdentity(editor, pageIndex);
        return editorMarkupSubtypeOverrides.get(identity) ?? null;
    }

    function getMarkupSubtypeOverrides() {
        return markupSubtypeOverrides;
    }

    function isSelectionMarkupTool(tool: TAnnotationTool) {
        return tool === 'highlight' || tool === 'underline' || tool === 'strikethrough';
    }

    function shouldForceTextMarkup(tool: TAnnotationTool) {
        return tool === 'underline' || tool === 'strikethrough';
    }

    function resolveHighlightColorForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        switch (tool) {
            case 'underline':
                return colorWithOpacity(settings.underlineColor, settings.underlineOpacity);
            case 'strikethrough':
                return colorWithOpacity(settings.strikethroughColor, settings.strikethroughOpacity);
            default:
                return colorWithOpacity(settings.highlightColor, settings.highlightOpacity);
        }
    }

    function resolveHighlightFreeForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        if (shouldForceTextMarkup(tool)) {
            return false;
        }
        return settings.highlightFree;
    }

    function applyHighlightParamsForTool(
        uiManager: AnnotationEditorUIManager,
        settings: IAnnotationSettings,
        tool: TAnnotationTool,
    ) {
        uiManager.updateParams(
            AnnotationEditorParamsType.HIGHLIGHT_COLOR,
            resolveHighlightColorForTool(settings, tool),
        );
        uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, settings.highlightThickness);
        uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_FREE, resolveHighlightFreeForTool(settings, tool));
        uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL, settings.highlightShowAll);
    }

    function clearOverrides() {
        markupSubtypeOverrides.clear();
        editorMarkupSubtypeOverrides.clear();
    }

    return {
        TOOL_TO_MARKUP_SUBTYPE,
        resolveMarkupSubtypeColor,
        resolveEditorHighlightClipPathId,
        resolveEditorDrawLayerHighlight,
        findClosestHighlightDrawLayerSvg,
        clearMarkupSubtypeEditorClass,
        applyEditorMarkupSubtypePresentation,
        resolveEditorSubtypeFromPresentation,
        syncMarkupSubtypePresentationForEditors,
        setEditorMarkupSubtypeOverride,
        resolveEditorMarkupSubtypeOverride,
        getMarkupSubtypeOverrides,
        isSelectionMarkupTool,
        shouldForceTextMarkup,
        resolveHighlightColorForTool,
        resolveHighlightFreeForTool,
        applyHighlightParamsForTool,
        clearOverrides,
        markupSubtypeOverrides,
    };
}
