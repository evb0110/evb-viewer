import {ref} from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    shouldShowDjvuConversionBanner,
    useDocumentWorkspaceViewerPresentation,
} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation';

describe('shouldShowDjvuConversionBanner', () => {
    const readyPresentation = {
        conversionUiAvailable: true,
        documentOpenReady: true,
        initialDocumentVisualReady: true,
        showDjvuBanner: true,
        showDjvuSource: true,
    };

    it('waits for the active DjVu source to make a durable initial visual commit', () => {
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            documentOpenReady: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            initialDocumentVisualReady: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            showDjvuSource: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner(readyPresentation)).toBe(true);
    });

    it('does not revive an unavailable or dismissed conversion notice', () => {
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            conversionUiAvailable: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            showDjvuBanner: false,
        })).toBe(false);
    });
});

describe('useDocumentWorkspaceViewerPresentation', () => {
    const baseOptions = {
        activeViewerCapabilities: ref({
            closeableDocument: true,
            conversionBanner: false,
            conversionDialog: false,
        }),
        canUseDjvu: true,
        conversionState: ref({isConverting: false}),
        documentOpenReady: ref(true),
        djvuOpeningPath: ref<unknown>(null),
        djvuShowBanner: ref(false),
        initialDocumentVisualReady: ref(true),
        pendingDjvuDocumentOpen: ref(false),
        showDjvuSource: ref(false),
        showNativePdfViewer: ref(false),
        showStandardPdfViewer: ref(true),
    };

    it('requires the active driver capability before exposing a viewer document', () => {
        const options = {
            ...baseOptions,
            activeViewerCapabilities: ref({
                ...baseOptions.activeViewerCapabilities.value,
                closeableDocument: false,
            }),
        };
        const presentation = useDocumentWorkspaceViewerPresentation(options);

        expect(presentation.showWorkspaceViewerDocument.value).toBe(false);

        options.activeViewerCapabilities.value = {
            ...options.activeViewerCapabilities.value,
            closeableDocument: true,
        };
        expect(presentation.showWorkspaceViewerDocument.value).toBe(true);
    });
});
