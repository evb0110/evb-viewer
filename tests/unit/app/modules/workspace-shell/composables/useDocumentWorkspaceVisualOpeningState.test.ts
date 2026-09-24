import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useDocumentWorkspaceVisualOpeningState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceVisualOpeningState';
import { createPageLabelModel } from '@app/modules/document-viewer/pageLabels';

describe('useDocumentWorkspaceVisualOpeningState', () => {
    it('keeps all document controls disabled before the first page paints', () => {
        const state = useDocumentWorkspaceVisualOpeningState({
            toolbarHasPdf: ref(true),
            isLoading: ref(true),
            initialDocumentVisualReady: ref(false),
            pdfError: ref(null),
            djvuError: ref(null),
            isOpeningDocumentForToolbar: ref(true),
            toolbarDocumentBusy: ref(true),
            canRepairSave: ref(false),
            canOptimizePdf: ref(false),
            statusZoomLabel: ref('376%'),
            totalPages: ref(882),
            pageLabels: ref(null),
            pageLabelsResolved: ref(false),
            isAnySaving: ref(false),
            t: () => 'Unknown zoom',
        });

        expect(state.documentMetadataReady.value).toBe(false);
        expect(state.toolbarControlsDisabled.value).toBe(true);
    });

    it('keeps the compact page-label model while a new revision rereads its labels', () => {
        const pageLabelModel = createPageLabelModel(882, [
            {
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            },
            {
                startPage: 3,
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
        ]);
        const state = useDocumentWorkspaceVisualOpeningState({
            toolbarHasPdf: ref(true),
            isLoading: ref(false),
            initialDocumentVisualReady: ref(true),
            pdfError: ref(null),
            djvuError: ref(null),
            isOpeningDocumentForToolbar: ref(false),
            toolbarDocumentBusy: ref(false),
            canRepairSave: ref(false),
            canOptimizePdf: ref(false),
            statusZoomLabel: ref('144%'),
            totalPages: ref(882),
            pageLabels: ref(null),
            pageLabelModel: ref(pageLabelModel),
            pageLabelsResolved: ref(false),
            isAnySaving: ref(false),
            t: () => 'Unknown zoom',
        });

        expect(state.toolbarPageLabels.value).toMatchObject({
            totalPages: 882,
            ranges: pageLabelModel.ranges,
        });
    });

    it('publishes the compact page-label model after metadata resolves', () => {
        const pageLabelModel = createPageLabelModel(273, [
            {
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            },
            {
                startPage: 2,
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 273,
                style: null,
                prefix: 'Back Cover',
                startNumber: 1,
            },
        ]);
        const state = useDocumentWorkspaceVisualOpeningState({
            toolbarHasPdf: ref(true),
            isLoading: ref(false),
            initialDocumentVisualReady: ref(true),
            pdfError: ref(null),
            djvuError: ref(null),
            isOpeningDocumentForToolbar: ref(false),
            toolbarDocumentBusy: ref(false),
            canRepairSave: ref(false),
            canOptimizePdf: ref(false),
            statusZoomLabel: ref('133%'),
            totalPages: ref(273),
            pageLabels: ref(null),
            pageLabelModel: ref(pageLabelModel),
            pageLabelsResolved: ref(true),
            isAnySaving: ref(false),
            t: () => 'Unknown zoom',
        });

        expect(state.toolbarPageLabels.value).toMatchObject({
            totalPages: 273,
            ranges: pageLabelModel.ranges,
        });
    });
});
