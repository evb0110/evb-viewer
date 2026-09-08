import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfjsAnnotationLayer,
    createPdfjsDrawLayer,
    createPdfjsEditorLayer,
    createPdfjsEventBus,
    createPdfjsGenericL10n,
    createPdfjsTextLayer,
    createPdfjsUiManager,
    getPdfjsEditorCompatibilityRuntime,
    hasSelectedPdfjsEditor,
    interceptPdfjsCleanUndoStack,
    interceptPdfjsDelete,
    interceptPdfjsRegisterEditorTypes,
    renderPdfjsAnnotationLayer,
} from '@app/services/pdfjs/pdfViewerFacade';

const runtimeMocks = vi.hoisted(() => ({
    AnnotationEditorLayer: vi.fn(),
    AnnotationEditorUIManager: vi.fn(),
    AnnotationLayer: vi.fn(),
    DrawLayer: vi.fn(),
    TextLayer: vi.fn(),
}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    default: { version: '6.3.311' },
    ...runtimeMocks,
}));

describe('pdfViewerFacade', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps named UI manager options to the pdf.js positional constructor', () => {
        const container = {} as HTMLElement;
        const viewer = {} as HTMLElement;
        const eventBus = {};
        const documentProxy = {};
        const commentManager = {};

        createPdfjsUiManager({
            container,
            viewer,
            commentManager,
            eventBus: eventBus as never,
            document: documentProxy as never,
            highlightColors: 'yellow=#FFFF98',
            supportsPinchToZoom: true,
        });

        expect(runtimeMocks.AnnotationEditorUIManager).toHaveBeenCalledWith(
            container,
            viewer,
            null,
            null,
            commentManager,
            null,
            eventBus,
            documentProxy,
            null,
            'yellow=#FFFF98',
            false,
            false,
            false,
            null,
            null,
            true,
        );
    });

    it('owns viewer runtime class construction', async () => {
        const page = {};
        const viewport = {};
        const linkService = {};
        const div = {} as HTMLDivElement;
        const uiManager = {};
        const drawLayer = {};
        const l10n = {};
        const annotationLayerRender = vi.fn();

        createPdfjsAnnotationLayer({
            div,
            page: page as never,
            viewport: viewport as never,
            annotationEditorUiManager: uiManager as never,
            linkService: linkService as never,
        });
        await renderPdfjsAnnotationLayer(
            {render: annotationLayerRender} as never,
            {
                annotations: [],
                div,
                page: page as never,
                viewport: viewport as never,
                linkService: linkService as never,
                renderForms: false,
            },
        );
        createPdfjsEditorLayer({
            div,
            uiManager: uiManager as never,
            pageIndex: 2,
            l10n: l10n as never,
            viewport: viewport as never,
            drawLayer: drawLayer as never,
        });
        createPdfjsDrawLayer();
        createPdfjsTextLayer({} as never);

        expect(runtimeMocks.AnnotationLayer).toHaveBeenCalledWith(expect.objectContaining({
            div,
            page,
            viewport,
            annotationEditorUIManager: uiManager,
            linkService,
        }));
        expect(annotationLayerRender).toHaveBeenCalledWith({
            annotations: [],
            viewport,
            div,
            page,
            linkService,
            renderForms: false,
            annotationStorage: undefined,
        });
        expect(runtimeMocks.AnnotationEditorLayer).toHaveBeenCalledWith(expect.objectContaining({
            div,
            uiManager,
            pageIndex: 2,
            l10n,
            viewport,
            drawLayer,
        }));
        expect(runtimeMocks.DrawLayer).toHaveBeenCalledOnce();
        expect(runtimeMocks.DrawLayer).toHaveBeenCalledWith({pageIndex: 0});
        expect(runtimeMocks.TextLayer).toHaveBeenCalledWith({});
        expect(getPdfjsEditorCompatibilityRuntime()).toEqual({
            version: '6.3.311',
            AnnotationEditorLayer: runtimeMocks.AnnotationEditorLayer,
            AnnotationEditorUIManager: runtimeMocks.AnnotationEditorUIManager,
        });
    });

    it('constructs injected viewer-only classes without importing the runtime probe', () => {
        class EventBus { readonly kind = 'event-bus'; }
        let receivedLang: unknown = 'not-constructed';
        class GenericL10n {
            readonly constructed = true;

            constructor(lang: undefined) {
                receivedLang = lang;
            }
        }

        expect(createPdfjsEventBus(EventBus as never)).toBeInstanceOf(EventBus);
        const l10n = createPdfjsGenericL10n(GenericL10n as never);
        expect(l10n).toBeInstanceOf(GenericL10n);
        expect(receivedLang).toBeUndefined();
    });

    it('centralizes optional UI manager capabilities', () => {
        const onRegister = vi.fn();
        const onClean = vi.fn();
        const afterDelete = vi.fn();
        const registerEditorTypes = vi.fn();
        const cleanUndoStack = vi.fn((_type: number) => 'cleaned');
        const deleteSelection = vi.fn(() => 'deleted');
        const uiManager = {
            hasSelection: true,
            registerEditorTypes,
            cleanUndoStack,
            delete: deleteSelection,
        };
        const typedUiManager = uiManager as never;

        expect(interceptPdfjsRegisterEditorTypes(typedUiManager, onRegister)).toBe(true);
        expect(interceptPdfjsCleanUndoStack(typedUiManager, onClean)).toBe(true);
        expect(interceptPdfjsDelete(typedUiManager, afterDelete)).toBe(true);
        expect(hasSelectedPdfjsEditor(typedUiManager)).toBe(true);

        const types = [{}];
        expect(uiManager.registerEditorTypes(types)).toBeUndefined();
        expect(uiManager.cleanUndoStack(7)).toBe('cleaned');
        expect(uiManager.delete()).toBe('deleted');
        expect(onRegister).toHaveBeenCalledWith(types);
        expect(onClean).toHaveBeenCalledWith(7);
        expect(afterDelete).toHaveBeenCalledOnce();
    });
});
