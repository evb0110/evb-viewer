import { reactive } from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { usePdfViewerPropModel } from '@app/modules/pdf-viewer/runtime/contracts/usePdfViewerPropModel';

describe('usePdfViewerPropModel', () => {
    it('normalizes PdfViewer public prop defaults', () => {
        const props = reactive<IPdfViewerProps>({src: null});

        const model = usePdfViewerPropModel(props);

        expect(model.src.value).toBeNull();
        expect(model.sourcePdfData.value).toBeNull();
        expect(model.suppressLoadingOverlay.value).toBe(false);
        expect(model.bufferPages.value).toBe(1);
        expect(model.isAnySaving.value).toBe(false);
        expect(model.zoom.value).toBe(1);
        expect(model.dragMode.value).toBe(false);
        expect(model.fitMode.value).toBe('width');
        expect(model.zoomMode.value).toBe('fit-width');
        expect(model.viewMode.value).toBe('single');
        expect(model.isResizing.value).toBe(false);
        expect(model.showAnnotations.value).toBe(true);
        expect(model.annotationTool.value).toBe('none');
        expect(model.annotationCursorMode.value).toBe(false);
        expect(model.annotationKeepActive.value).toBe(true);
        expect(model.annotationSettings.value).toBeNull();
        expect(model.currentSearchMatch.value).toBeNull();
        expect(model.currentSearchMatchNavigationId.value).toBe(0);
        expect(model.workingCopyPath.value).toBeNull();
        expect(model.continuousScroll.value).toBe(true);
        expect(model.isActive.value).toBe(true);
        expect(model.authorName.value).toBeUndefined();
    });

    it('derives fit-height zoom mode from height fit mode unless zoom mode is explicit', () => {
        const props = reactive<IPdfViewerProps>({
            src: null,
            fitMode: 'height',
        });

        const model = usePdfViewerPropModel(props);

        expect(model.zoomMode.value).toBe('fit-height');

        props.zoomMode = 'custom';

        expect(model.zoomMode.value).toBe('custom');
    });

    it('uses one zoom-state authority when legacy mode props disagree', () => {
        const props = reactive<IPdfViewerProps>({
            src: null,
            fitMode: 'height',
            zoomMode: 'fit-width',
            zoom: 1.75,
        });
        const model = usePdfViewerPropModel(props);

        expect(model.zoomState.value).toEqual({
            kind: 'fit',
            axis: 'width',
        });
        expect(model.fitMode.value).toBe('width');
        expect(model.zoomMode.value).toBe('fit-width');
    });

    it('keeps invertColors as a public component prop instead of feature-model state', () => {
        const props = reactive<IPdfViewerProps>({
            src: null,
            invertColors: true,
        });

        const model = usePdfViewerPropModel(props);

        expect(props.invertColors).toBe(true);
        expect('invertColors' in model).toBe(false);
    });
});
