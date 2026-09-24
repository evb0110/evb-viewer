// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertPdfjsRuntimeCompatibility,
    assertPdfjsVendoredAssetVersion,
    getPdfjsBrowserRuntimeProbeFailures,
    getPdfjsRuntimeProbeFailures,
} from '@app/services/pdfjs/runtimeLib';

function createStaticFunction(properties: Record<string, unknown> = {}) {
    return Object.assign(function StaticPdfjsExport() {}, properties);
}

function createAnnotationEditorUIManager() {
    return class MockAnnotationEditorUIManager {
        get currentLayer() { return null; }
        public addCommands() {}
        public addEditListeners() {}
        public addToAnnotationStorage() {}
        public delete() {}
        public destroy() {}
        public getEditors() { return []; }
        public getMode() { return 0; }
        public onPageChanging() {}
        public onScaleChanging() {}
        public removeEditListeners() {}
        public setSelected() {}
        public updateParams() {}
        public waitForEditorsRendered() { return Promise.resolve(); }
    };
}

function createAnnotationEditorLayer() {
    return class MockAnnotationEditorLayer {
        public disable() {}
        public destroy() {}
    };
}

function createCompatibleRuntime(overrides: Record<PropertyKey, unknown> = {}) {
    return {
        version: '6.3.311',
        getDocument() {},
        GlobalWorkerOptions: {workerSrc: './pdf.worker.mjs'},
        VerbosityLevel: {ERRORS: 0},
        PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
        AnnotationLayer: createStaticFunction(),
        AnnotationEditorLayer: createAnnotationEditorLayer(),
        AnnotationEditorParamsType: {
            RESIZE: 1,
            CREATE: 2,
            FREETEXT_SIZE: 11,
            FREETEXT_COLOR: 12,
            INK_COLOR: 21,
            INK_THICKNESS: 22,
            INK_OPACITY: 23,
            HIGHLIGHT_COLOR: 31,
            HIGHLIGHT_THICKNESS: 32,
            HIGHLIGHT_FREE: 33,
            HIGHLIGHT_SHOW_ALL: 34,
            DRAW_STEP: 41,
        },
        AnnotationEditorType: {
            DISABLE: -1,
            NONE: 0,
            FREETEXT: 3,
            HIGHLIGHT: 9,
            STAMP: 13,
            INK: 15,
            POPUP: 16,
        },
        AnnotationEditorUIManager: createAnnotationEditorUIManager(),
        AnnotationMode: {
            DISABLE: 0,
            ENABLE: 1,
            ENABLE_FORMS: 2,
            ENABLE_STORAGE: 3,
        },
        DrawLayer: createStaticFunction(),
        PDFDateString: createStaticFunction({toDateObject() { return null; }}),
        PixelsPerInch: {
            CSS: 96,
            PDF: 72,
            PDF_TO_CSS_UNITS: 96 / 72,
        },
        TextLayer: createStaticFunction(),
        ...overrides,
    };
}

describe('pdf.js runtime adapter probes', () => {
    it('smokes the installed pdf.js runtime contract used by the app', () => {
        expect(getPdfjsRuntimeProbeFailures()).toEqual([]);
    });

    it('reports clear core browser runtime failures', () => {
        const runtime = createCompatibleRuntime({
            version: '',
            PDFDataRangeTransport: undefined,
        });

        expect(getPdfjsBrowserRuntimeProbeFailures(runtime)).toEqual([
            'version export is missing',
            'PDFDataRangeTransport export is not a constructor',
        ]);
    });

    it('fails the app runtime probe when a fragile annotation export is missing', () => {
        const runtime = createCompatibleRuntime({AnnotationEditorType: {HIGHLIGHT: 9}});

        expect(getPdfjsRuntimeProbeFailures(runtime)).toContain('AnnotationEditorType.FREETEXT is not a finite number');
        expect(() => assertPdfjsRuntimeCompatibility(runtime))
            .toThrow(/PDF\.js app runtime is incompatible with pdfjs-dist 6\.3\.311/u);
    });

    it('asserts vendored asset stamps against the runtime version', async () => {
        const runtime = createCompatibleRuntime();

        await expect(assertPdfjsVendoredAssetVersion(runtime, {
            force: true,
            readVersionStamp: async () => '6.3.311\n',
        })).resolves.toBeUndefined();
    });

    it('rejects missing and mismatched vendored asset stamps clearly', async () => {
        const runtime = createCompatibleRuntime();

        await expect(assertPdfjsVendoredAssetVersion(runtime, {
            force: true,
            readVersionStamp: async () => '',
        })).rejects.toThrow('PDF.js vendored asset version stamp is empty');

        await expect(assertPdfjsVendoredAssetVersion(runtime, {
            force: true,
            readVersionStamp: async () => '5.7.283',
        })).rejects.toThrow('installed runtime is 6.3.311, vendored assets are 5.7.283');
    });
});
