import type {
    ComputedRef,
    Ref,
} from 'vue';
import { whenever } from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import { usePdfDrag } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDrag';
import { isSelectionInteractionTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionInteractionTool';
import { isSelectionMarkupTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

interface IUsePdfViewerSelectionToolStateOptions {
    dragMode: ComputedRef<boolean>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    pendingImagePlacement: Ref<unknown | null>;
    viewportWritePort: IPdfViewportWritePort;
}

export const usePdfViewerSelectionToolState = (options: IUsePdfViewerSelectionToolStateOptions) => {
    const isImagePlacementActive = computed(() => options.pendingImagePlacement.value !== null);
    const isViewerPanDragModeActive = computed(() => options.dragMode.value && !isImagePlacementActive.value);
    const isSelectionMarkupToolActive = computed(() => isSelectionMarkupTool(options.annotationTool.value));
    const isTextSelectionModeActive = computed(() =>
        options.annotationCursorMode.value
        && (
            options.annotationTool.value === 'none'
            || isSelectionInteractionTool(options.annotationTool.value)
        ),
    );
    const selectionMarkupStyle = computed(() => {
        if (!isSelectionMarkupToolActive.value) {
            return null;
        }
        const settings = options.annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS;
        const {
            color,
            opacity,
        } = (() => {
            if (options.annotationTool.value === 'underline') {
                return {
                    color: settings.underlineColor,
                    opacity: settings.underlineOpacity,
                };
            }
            if (options.annotationTool.value === 'strikethrough') {
                return {
                    color: settings.strikethroughColor,
                    opacity: settings.strikethroughOpacity,
                };
            }
            if (options.annotationTool.value === 'squiggly') {
                return {
                    color: settings.squigglyColor,
                    opacity: settings.squigglyOpacity,
                };
            }
            return {
                color: settings.highlightColor,
                opacity: settings.highlightOpacity,
            };
        })();
        const opacityPercent = Math.round(clamp(opacity, 0, 1) * 100);
        return { '--app-pdf-text-selection-bg': `color-mix(in srgb, ${color} ${opacityPercent}%, transparent)` };
    });

    const drag = usePdfDrag(() => isViewerPanDragModeActive.value, options.viewportWritePort);
    whenever(isImagePlacementActive, () => {
        drag.stopDrag();
    });

    return {
        isImagePlacementActive,
        isViewerPanDragModeActive,
        isSelectionMarkupToolActive,
        isTextSelectionModeActive,
        selectionMarkupStyle,
        isDragging: drag.isDragging,
        startDrag: drag.startDrag,
        onDrag: drag.onDrag,
        stopDrag: drag.stopDrag,
    };
};
