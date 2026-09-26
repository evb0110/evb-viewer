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
        expect(model.bufferPages.value).toBe(1);
        expect(model.isAnySaving.value).toBe(false);
        expect(model.zoom.value).toBe(1);
        expect(model.dragMode.value).toBe(false);
        expect(model.fitMode.value).toBe('width');
        expect(model.zoomMode.value).toBe('fit-width');
        expect(model.viewMode.value).toBe('single');
        expect(model.isResizing.value).toBe(false);
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

    it('derives zoom mode, fit axis and manual scale from one zoom state', () => {
        const props = reactive<IPdfViewerProps>({
            src: null,
            zoomState: {
                kind: 'custom',
                scale: 1.75,
            },
        });
        const model = usePdfViewerPropModel(props);

        expect(model.zoomMode.value).toBe('custom');
        expect(model.zoom.value).toBe(1.75);

        props.zoomState = {
            kind: 'fit',
            axis: 'height',
        };

        expect(model.zoomMode.value).toBe('fit-height');
        expect(model.fitMode.value).toBe('height');
        // A fit keeps the last manual scale.
        expect(model.zoom.value).toBe(1.75);
    });
});
