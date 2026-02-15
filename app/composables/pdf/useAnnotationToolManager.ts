import {
    AnnotationEditorParamsType,
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import {
    ref,
    nextTick,
    type Ref,
    type ShallowRef,
} from 'vue';
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import { errorToLogText } from '@app/composables/pdf/pdfAnnotationUtils';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import type { useFreeTextResize } from '@app/composables/pdf/useFreeTextResize';

type TMarkupSubtypeComposable = ReturnType<typeof useAnnotationMarkupSubtype>;
type TFreeTextResize = ReturnType<typeof useFreeTextResize>;

interface IUseAnnotationToolManagerOptions {
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    annotationCursorMode: Ref<boolean>;
    annotationKeepActive: Ref<boolean>;
    freeTextResize: TFreeTextResize;
    markupSubtype: TMarkupSubtypeComposable;
    emitAnnotationToolAutoReset: () => void;
}

export function useAnnotationToolManager(options: IUseAnnotationToolManagerOptions) {
    const {
        annotationUiManager,
        currentPage,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        freeTextResize,
        markupSubtype,
        emitAnnotationToolAutoReset,
    } = options;

    const pendingAnnotationTool = ref<TAnnotationTool>(annotationTool.value);
    const pendingAnnotationSettings = ref<IAnnotationSettings | null>(null);
    let annotationToolUpdateToken = 0;
    let annotationToolUpdatePromise: Promise<void> = Promise.resolve();

    function getAnnotationMode(tool: TAnnotationTool) {
        switch (tool) {
            case 'highlight':
            case 'underline':
            case 'strikethrough':
                return AnnotationEditorType.NONE;
            case 'text':
                return AnnotationEditorType.FREETEXT;
            case 'draw':
                return AnnotationEditorType.INK;
            case 'stamp':
                return AnnotationEditorType.STAMP;
            case 'rectangle':
            case 'circle':
            case 'line':
            case 'arrow':
                return AnnotationEditorType.NONE;
            case 'none':
            default:
                return annotationCursorMode.value
                    ? AnnotationEditorType.POPUP
                    : AnnotationEditorType.NONE;
        }
    }

    function applyAnnotationSettings(settings: IAnnotationSettings | null) {
        pendingAnnotationSettings.value = settings;
        const uiManager = annotationUiManager.value;
        if (!uiManager || !settings) {
            return;
        }

        const tool = annotationTool.value;
        markupSubtype.applyHighlightParamsForTool(uiManager, settings, tool);
        uiManager.updateParams(AnnotationEditorParamsType.INK_COLOR, settings.inkColor);
        uiManager.updateParams(AnnotationEditorParamsType.INK_OPACITY, settings.inkOpacity);
        uiManager.updateParams(AnnotationEditorParamsType.INK_THICKNESS, settings.inkThickness);
        uiManager.updateParams(AnnotationEditorParamsType.FREETEXT_COLOR, settings.textColor);
        uiManager.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, settings.textSize);
        freeTextResize.patchResizableFreeTextEditors(uiManager);
        markupSubtype.syncMarkupSubtypePresentationForEditors();
    }

    async function updateModeWithRetry(
        uiManager: AnnotationEditorUIManager,
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber = currentPage.value,
    ) {
        try {
            await uiManager.updateMode(mode);
            return null;
        } catch (initialError) {
            BrowserLogger.debug('annotations', `Annotation mode switch will retry: ${errorToLogText(initialError)}`);
            try {
                await uiManager.waitForEditorsRendered(Math.max(1, pageNumber));
            } catch (waitError) {
                BrowserLogger.debug('annotations', `Failed to wait for editor render before mode retry: ${errorToLogText(waitError)}`);
            }
            await nextTick();
        }

        try {
            await uiManager.updateMode(mode);
            return null;
        } catch (retryError) {
            return retryError;
        }
    }

    async function setAnnotationTool(tool: TAnnotationTool) {
        pendingAnnotationTool.value = tool;
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return;
        }
        const localToken = ++annotationToolUpdateToken;

        annotationToolUpdatePromise = annotationToolUpdatePromise.then(async () => {
            if (annotationToolUpdateToken !== localToken) {
                return;
            }

            const effectiveTool = pendingAnnotationTool.value;
            const mode = getAnnotationMode(effectiveTool);
            const settings = pendingAnnotationSettings.value;

            if (settings) {
                markupSubtype.applyHighlightParamsForTool(uiManager, settings, effectiveTool);
            }

            const modeError = await updateModeWithRetry(uiManager, mode, currentPage.value);
            if (modeError) {
                BrowserLogger.warn('annotations', `Failed to update annotation tool mode: ${errorToLogText(modeError)}`);
                return;
            }

            if (annotationToolUpdateToken !== localToken || !settings) {
                return;
            }

            applyAnnotationSettings(settings);
            freeTextResize.patchResizableFreeTextEditors(uiManager);
        }).catch((error: unknown) => {
            BrowserLogger.warn('annotations', 'Failed to apply annotation tool update', error);
        });

        await annotationToolUpdatePromise;
    }

    function maybeAutoResetAnnotationTool() {
        if (annotationKeepActive.value) {
            return;
        }
        if (annotationTool.value === 'none') {
            return;
        }
        queueMicrotask(() => {
            emitAnnotationToolAutoReset();
        });
    }

    return {
        pendingAnnotationTool,
        pendingAnnotationSettings,
        getAnnotationMode,
        applyAnnotationSettings,
        updateModeWithRetry,
        setAnnotationTool,
        maybeAutoResetAnnotationTool,
    };
}
