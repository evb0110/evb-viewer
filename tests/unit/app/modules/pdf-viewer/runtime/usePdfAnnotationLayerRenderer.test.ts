// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {usePdfAnnotationLayerRenderer} from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import type {ILinkAnnotation} from '@app/types/annotations';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const annotationLayerCtor = vi.fn();
const annotationLayerRender = vi.fn(async (_options: unknown) => {});

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    default: {version: '6.3.311'},
    AnnotationLayer: class MockAnnotationLayer {
        constructor(options: unknown) {
            annotationLayerCtor(options);
        }

        render(options: unknown) {
            return annotationLayerRender(options);
        }
    },
}));

const platformApi = createElectronPlatformApiFixture();
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));

function createRenderer(overrides: Record<string, unknown> = {}) {
    return usePdfAnnotationLayerRenderer({
        numPages: ref(3),
        currentPage: ref(1),
        pdfDocument: ref({annotationStorage: {}} as never),
        ...overrides,
    });
}

function createPageProxy(annotations: unknown[] = []) {
    return {
        getAnnotations: vi.fn(async () => annotations),
        rotate: 0,
        view: [
            0,
            0,
            200,
            300,
        ],
    };
}

describe('usePdfAnnotationLayerRenderer', () => {
    beforeEach(() => {
        annotationLayerCtor.mockClear();
        annotationLayerRender.mockClear();
    });

    it('renders the static PDF.js annotation layer with the shared canvas map', async () => {
        const renderer = createRenderer();
        const viewport = {
            width: 200,
            height: 300,
            rotation: 0,
        };
        const pdfPage = createPageProxy([{
            id: 'stamp-1',
            annotationType: 13,
            rect: [
                0,
                0,
                10,
                10,
            ],
            noHTML: false,
        }]);
        const annotationLayerDiv = document.createElement('div');
        const annotationCanvasMap = new Map<string, HTMLCanvasElement>([[
            'stamp-1',
            document.createElement('canvas'),
        ]]);

        await renderer.renderAnnotationLayer(
            pdfPage as never,
            annotationLayerDiv,
            viewport as never,
            1,
            annotationCanvasMap,
        );

        expect(annotationLayerCtor).toHaveBeenCalledWith(expect.objectContaining({
            annotationCanvasMap,
            div: annotationLayerDiv,
            page: pdfPage,
            viewport,
            annotationEditorUIManager: null,
        }));
        expect(annotationLayerRender).toHaveBeenCalledWith(expect.objectContaining({
            annotations: expect.arrayContaining([expect.objectContaining({id: 'stamp-1'})]),
            div: annotationLayerDiv,
            page: pdfPage,
            viewport,
        }));
    });

    it('filters canonical PDF refs before asking PDF.js to render them', async () => {
        const renderer = createRenderer({hiddenAnnotationIds: ref(new Set(['hidden-1']))});
        const pdfPage = createPageProxy([
            {
                id: 'hidden-1',
                annotationType: 10,
                noHTML: false,
            },
            {
                id: 'visible-1',
                annotationType: 10,
                noHTML: false,
            },
        ]);
        const annotationLayerDiv = document.createElement('div');

        await renderer.renderAnnotationLayer(
            pdfPage as never,
            annotationLayerDiv,
            {
                width: 200,
                height: 300,
                rotation: 0,
            } as never,
            1,
        );

        expect(annotationLayerRender).toHaveBeenCalledWith(expect.objectContaining({annotations: [expect.objectContaining({id: 'visible-1'})]}));
    });

    it('keeps foreign links visible while the canonical ownership parse is pending', async () => {
        const annotationProjectionReady = ref(false);
        const renderer = createRenderer({annotationProjectionReady});
        const pdfPage = createPageProxy([
            {
                id: 'link-1',
                annotationType: 2,
                noHTML: false,
            },
            {
                id: 'owned-1',
                annotationType: 10,
                noHTML: false,
            },
        ]);
        const annotationLayerDiv = document.createElement('div');

        await renderer.renderAnnotationLayer(
            pdfPage as never,
            annotationLayerDiv,
            {
                width: 200,
                height: 300,
                rotation: 0,
            } as never,
            1,
        );

        expect(annotationLayerRender).toHaveBeenLastCalledWith(expect.objectContaining({annotations: [expect.objectContaining({id: 'link-1'})]}));

        annotationProjectionReady.value = true;
        await renderer.renderAnnotationLayer(
            pdfPage as never,
            annotationLayerDiv,
            {
                width: 200,
                height: 300,
                rotation: 0,
            } as never,
            1,
        );

        expect(annotationLayerRender).toHaveBeenLastCalledWith(expect.objectContaining({annotations: expect.arrayContaining([
            expect.objectContaining({id: 'link-1'}),
            expect.objectContaining({id: 'owned-1'}),
        ])}));
    });

    it('publishes link geometry from the same page annotations used for PDF.js rendering', async () => {
        const linkAnnotations = ref<ILinkAnnotation[]>([]);
        const renderer = createRenderer({linkAnnotations});
        const pdfPage = createPageProxy([
            {
                id: 'external-link',
                annotationType: 2,
                rect: [
                    20,
                    30,
                    120,
                    130,
                ],
                url: 'https://example.com/annotation',
            },
            {
                id: 'internal-link',
                annotationType: 2,
                rect: [
                    40,
                    50,
                    80,
                    90,
                ],
                dest: ['page-2'],
            },
            {
                id: 'link-without-target',
                annotationType: 2,
                rect: [
                    10,
                    10,
                    20,
                    20,
                ],
            },
        ]);

        await renderer.renderAnnotationLayer(
            pdfPage as never,
            document.createElement('div'),
            {
                width: 200,
                height: 300,
                rotation: 0,
            } as never,
            1,
        );

        expect(linkAnnotations.value).toHaveLength(2);
        expect(linkAnnotations.value).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'external-link',
                pageNumber: 1,
                url: 'https://example.com/annotation',
                rect: expect.objectContaining({
                    left: 0.1,
                    width: 0.5,
                }),
            }),
            expect.objectContaining({
                id: 'internal-link',
                pageNumber: 1,
                dest: ['page-2'],
            }),
        ]));

        renderer.clearAllLayers();
        expect(linkAnnotations.value).toEqual([]);
    });

    it('leaves the existing layer untouched when a render is aborted', async () => {
        const pending = Promise.withResolvers<unknown[]>();
        const renderer = createRenderer();
        const abortController = new AbortController();
        const pdfPage = {getAnnotations: vi.fn(() => pending.promise)};
        const annotationLayerDiv = document.createElement('div');
        annotationLayerDiv.innerHTML = '<section class="existingAnnotation"></section>';

        const renderPromise = renderer.renderAnnotationLayer(
            pdfPage as never,
            annotationLayerDiv,
            {
                width: 200,
                height: 300,
                rotation: 0,
            } as never,
            1,
            null,
            {signal: abortController.signal},
        ).catch(error => error as Error);
        await Promise.resolve();
        abortController.abort();

        await expect(renderPromise).resolves.toMatchObject({name: 'AbortError'});
        expect(annotationLayerRender).not.toHaveBeenCalled();
        expect(annotationLayerDiv.innerHTML).toContain('existingAnnotation');
        pending.resolve([]);
        await pending.promise;
        await Promise.resolve();
        expect(annotationLayerRender).not.toHaveBeenCalled();
        expect(annotationLayerDiv.innerHTML).toContain('existingAnnotation');
    });

    it('caches parsed annotations per page proxy while allowing a reloaded proxy to parse once', async () => {
        const renderer = createRenderer();
        const annotationLayerDiv = document.createElement('div');
        const renderAt = (pdfPage: unknown) => renderer.renderAnnotationLayer(
            pdfPage as never,
            annotationLayerDiv,
            {
                width: 200,
                height: 300,
                rotation: 0,
            } as never,
            1,
        );
        const firstPage = createPageProxy([{
            id: 'link-1',
            annotationType: 2,
            noHTML: false,
        }]);
        const reloadedPage = createPageProxy([{
            id: 'link-1',
            annotationType: 2,
            noHTML: false,
        }]);

        await renderAt(firstPage);
        await renderAt(firstPage);
        await renderAt(reloadedPage);

        expect(firstPage.getAnnotations).toHaveBeenCalledOnce();
        expect(reloadedPage.getAnnotations).toHaveBeenCalledOnce();
        expect(annotationLayerRender).toHaveBeenCalledTimes(3);
    });
});
