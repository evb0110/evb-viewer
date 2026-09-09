import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {TAnnotationTool} from '@app/types/annotations';
import {isSelectionMarkupTool} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import {runGuardedTask} from '@app/utils/asyncGuard';

interface IAnnotationSelectionCachePort {
    cacheCurrentTextSelection: () => void;
    beginSelectionGesture: () => void;
    invalidateSelectionForToolActivation: () => void;
}

interface IAnnotationSelectionLifecyclePort {invalidateActiveRequests: () => void;}

interface ICreateAnnotationSelectionInteractionControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    isActive: ComputedRef<boolean>;
    annotationTool: ComputedRef<TAnnotationTool>;
    selectionCache: IAnnotationSelectionCachePort;
    selectionLifecycle: IAnnotationSelectionLifecyclePort;
    applySelectionMarkup: (range?: Range | null) => Promise<boolean>;
}

/** Owns DOM selection and pointer gesture routing for all text-markup tools. */
export function createAnnotationSelectionInteractionController(
    options: ICreateAnnotationSelectionInteractionControllerOptions,
) {
    let selectionPointerId: number | null = null;
    const stopToolWatch = watch(options.annotationTool, tool => {
        selectionPointerId = null;
        options.selectionLifecycle.invalidateActiveRequests();
        if (!options.isActive.value || !isSelectionMarkupTool(tool)) {
            return;
        }
        runGuardedTask(
            async () => {
                await options.applySelectionMarkup();
            },
            {
                category: 'user-visible-operation',
                scope: 'annotations',
                message: 'Failed to apply selected text after activating markup tool',
            },
        );
    }, {flush: 'sync'});

    const handleDocumentPointerCancel = (event: PointerEvent) => {
        if (selectionPointerId === event.pointerId) {
            selectionPointerId = null;
        }
    };
    function handleDocumentPointerDown(event: PointerEvent) {
        if (event.button !== 0 || !options.isActive.value) {
            return;
        }
        const viewerContainer = options.viewerContainer.value;
        if (!viewerContainer || !(event.target instanceof Node)) {
            selectionPointerId = null;
            return;
        }
        const target = event.target instanceof Element ? event.target : event.target.parentElement;
        const textLayer = target?.closest<HTMLElement>('.text-layer, .textLayer');
        if (textLayer && viewerContainer.contains(textLayer)) {
            options.selectionCache.beginSelectionGesture();
            selectionPointerId = isSelectionMarkupTool(options.annotationTool.value)
                ? event.pointerId
                : null;
            return;
        }
        selectionPointerId = null;
        if (viewerContainer.contains(event.target)) {
            options.selectionCache.invalidateSelectionForToolActivation();
        }
    }
    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        if (!options.isActive.value) {
            selectionPointerId = null;
            return;
        }
        const viewerContainer = options.viewerContainer.value;
        if (!viewerContainer) {
            selectionPointerId = null;
            return;
        }
        if (!isSelectionMarkupTool(options.annotationTool.value)) {
            selectionPointerId = null;
            if (event.target instanceof Node && viewerContainer.contains(event.target)) {
                const selection = document.getSelection();
                if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                    options.selectionCache.invalidateSelectionForToolActivation();
                }
            }
            return;
        }
        if (selectionPointerId !== event.pointerId) {
            return;
        }
        selectionPointerId = null;
        const selection = document.getSelection();
        const range = selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).cloneRange()
            : null;
        if (!range || range.collapsed) {
            return;
        }
        runGuardedTask(
            () => options.applySelectionMarkup(range),
            {
                category: 'user-visible-operation',
                scope: 'annotations',
                message: 'Failed to apply selection markup on pointer up',
            },
        );
    }

    const handleSelectionChange = () => {
        if (options.isActive.value) {
            options.selectionCache.cacheCurrentTextSelection();
        }
    };
    const dispose = () => {
        stopToolWatch();
        if (typeof document === 'undefined') {
            return;
        }
        document.removeEventListener('selectionchange', handleSelectionChange);
        document.removeEventListener('pointerdown', handleDocumentPointerDown);
        document.removeEventListener('pointerup', handleDocumentPointerUp);
        document.removeEventListener('pointercancel', handleDocumentPointerCancel);
    };
    if (typeof document !== 'undefined') {
        document.addEventListener('selectionchange', handleSelectionChange, {passive: true});
        document.addEventListener('pointerdown', handleDocumentPointerDown, {passive: true});
        document.addEventListener('pointerup', handleDocumentPointerUp, {passive: true});
        document.addEventListener('pointercancel', handleDocumentPointerCancel, {passive: true});
    }
    return dispose;
}
