// @vitest-environment happy-dom

import type * as TPdfRenderViewModel from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    ref,
} from 'vue';
import { usePdfViewerFeatureController } from '@app/modules/pdf-viewer/runtime/usePdfViewerFeatureController';
import { createDocumentViewerRuntime } from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import type { TDocumentPageSourceKind } from '@app/modules/document-viewer/source/documentPageSource';
import type { IDocumentWheelInteraction } from '@app/modules/document-viewer/input/documentWheelInteraction';
import type {
    IPdfViewerEmit,
    IPdfViewerProps,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';

const renderViewModelCapture = vi.hoisted(() => ({options: null as unknown}));

beforeEach(() => {
    renderViewModelCapture.options = null;
});

vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel', async importOriginal => {
    const actual = await importOriginal<typeof TPdfRenderViewModel>();
    return {
        ...actual,
        usePdfRenderViewModel: vi.fn((options: Parameters<typeof actual.usePdfRenderViewModel>[0]) => {
            renderViewModelCapture.options = options;
            return actual.usePdfRenderViewModel(options);
        }),
    };
});

type TFeatureController = ReturnType<typeof usePdfViewerFeatureController>;

interface IPdfRenderStateOptions {
    isPageBuffered: (pageNumber: number) => boolean;
    isPageRenderedForClass: (pageNumber: number) => boolean;
    isPageRendering: (pageNumber: number) => boolean;
    isPageRenderFailed: (pageNumber: number) => boolean;
    shouldShowSkeleton: (pageNumber: number) => boolean;
}

function readUserViewportInteractionEpoch(controller: TFeatureController) {
    const readEpoch = controller.pdfViewerPublicApi.getUserViewportInteractionEpoch;
    if (!readEpoch) {
        throw new Error('The viewer public API no longer reports the user viewport interaction epoch.');
    }
    return readEpoch();
}

function createWheelInteraction(
    intent: IDocumentWheelInteraction['intent'],
    deltaPx: number,
): IDocumentWheelInteraction & {event: {preventDefault: ReturnType<typeof vi.fn>}} {
    const preventDefault = vi.fn();
    return {
        deltaPx,
        intent,
        event: {
            cancelable: true,
            clientX: 120,
            clientY: 240,
            defaultPrevented: false,
            deltaX: 0,
            deltaY: deltaPx,
            timeStamp: 0,
            preventDefault,
        },
    };
}

const mountedControllers: Array<() => void> = [];

afterEach(() => {
    mountedControllers.splice(0).forEach(dispose => dispose());
});

function mountFeatureController(props: Partial<IPdfViewerProps> = {}) {
    const emitted: Array<[string, ...unknown[]]> = [];
    const emit = ((event: string, ...args: unknown[]) => {
        emitted.push([
            event,
            ...args,
        ]);
    }) as IPdfViewerEmit;
    const chassisAuthority = createDocumentViewerRuntime(ref<TDocumentPageSourceKind>('pdf'));
    let controller: TFeatureController | null = null;
    const app = createApp(defineComponent({setup() {
        controller = usePdfViewerFeatureController(
            {
                src: null,
                ...props,
            },
            emit,
            chassisAuthority,
        );
        return () => h('div');
    }}));
    const host = document.createElement('div');
    document.body.append(host);
    app.mount(host);
    if (!controller) {
        throw new Error('The feature controller did not construct.');
    }
    mountedControllers.push(() => {
        app.unmount();
        host.remove();
    });
    return {
        controller: controller as TFeatureController,
        emitted,
    };
}

describe('usePdfViewerFeatureController wiring', () => {
    it('publishes the viewer container to the public API and releases it again', () => {
        const harness = mountFeatureController();
        const container = document.createElement('div');

        harness.controller.handleViewerContainerRef(container);
        expect(harness.controller.pdfViewerPublicApi.getViewerContainer()).toBe(container);

        harness.controller.handleViewerContainerRef(null);
        expect(harness.controller.pdfViewerPublicApi.getViewerContainer()).toBeNull();
    });

    it('emits a rejected annotation creation to the workspace', async () => {
        const harness = mountFeatureController();

        // No document is loaded, so the annotation editor manager is absent.
        await expect(harness.controller.pdfViewerPublicApi.commentAtPoint(requirePageNumber(1), 0.5, 0.5))
            .resolves.toBe(false);

        const failures = harness.emitted.filter(([event]) => event === 'annotation-failure');
        expect(failures).toHaveLength(1);
        expect(failures[0]?.[1]).toMatchObject({
            reason: 'viewer-not-ready',
            pageNumber: 1,
        });
    });

    it('survives a page number past the safe integer range', () => {
        const harness = mountFeatureController();

        // The public scrollToPage takes a plain number, so a caller can hand over
        // a finite page that is not a safe integer. requirePageNumber rejects one,
        // and branding it without a cap threw that RangeError at the caller.
        expect(() => harness.controller.pdfViewerPublicApi.scrollToPage(Number.MAX_SAFE_INTEGER * 4))
            .not.toThrow();
    });

    it('adapts every render-state read while the document page count is empty', () => {
        const harness = mountFeatureController();
        const options = renderViewModelCapture.options as IPdfRenderStateOptions | null;

        if (!options) {
            throw new Error('The render view model options were not captured.');
        }

        expect(harness.controller.isPageBuffered).toBe(options.isPageBuffered);
        expect(harness.controller.isPageRenderFailed).toBe(options.isPageRenderFailed);
        expect(harness.controller.pageRaster(requirePageNumber(5))).toBeNull();

        for (const predicateName of [
            'isPageBuffered',
            'isPageRenderedForClass',
            'isPageRendering',
            'isPageRenderFailed',
        ] as const) {
            expect(() => options[predicateName](5)).not.toThrow();
            expect(options[predicateName](5)).toBe(false);
        }

        expect(() => options.shouldShowSkeleton(5)).not.toThrow();
        expect(options.shouldShowSkeleton(5)).toBe(false);
        expect(harness.controller.shouldShowPageSkeleton(5)).toBe(false);
    });

    it('routes a modifier wheel packet into the zoom path', () => {
        const harness = mountFeatureController({src: new Blob([], {type: 'application/pdf'})});
        harness.controller.handleViewerContainerRef(document.createElement('div'));
        const interaction = createWheelInteraction('zoom', -120);

        harness.controller.handleViewerWheel(interaction);

        expect(interaction.event.preventDefault).toHaveBeenCalledTimes(1);
        const zoomUpdate = harness.emitted.find(([event]) => event === 'update:zoomState');
        expect(zoomUpdate?.[1]).toEqual({
            kind: 'custom',
            scale: expect.any(Number),
        });
        expect((zoomUpdate?.[1] as {scale: number}).scale).toBeGreaterThan(1);
    });

    it('routes a plain wheel packet to the viewport session as a user interaction', () => {
        const harness = mountFeatureController({continuousScroll: true});
        const before = readUserViewportInteractionEpoch(harness.controller);
        const interaction = createWheelInteraction('scroll', 120);

        harness.controller.handleViewerWheel(interaction);

        expect(interaction.event.preventDefault).not.toHaveBeenCalled();
        expect(readUserViewportInteractionEpoch(harness.controller)).toBeGreaterThan(before);
    });
});
