// @vitest-environment happy-dom
import type * as TViMockOriginalModule from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
import {
    afterEach, describe, expect, it, vi,
} from 'vitest';
import {
    createApp, defineComponent, h, inject, nextTick, ref, watch,
} from 'vue';
import {
    usePdfRegionSnip, pdfRegionSnipKeyboardKey,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import {capturePdfRegionAsPngBlob} from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
import type {ISnipPointerPayload} from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';
import type {FailurePresentation} from '@app/composables/useFailureToast';

const output = vi.hoisted(() => ({
    clipboard: null as Blob | null,
    failures: [] as FailurePresentation[],
}));
vi.mock('@app/composables/useFailureToast', () => ({
    useFailureToast: () => ({
        presentFailureToast: (failure: FailurePresentation) => output.failures.push(failure),
        presentNoticeToast: () => {},
    }),
    isFailurePresentation: () => false,
}));
vi.mock('@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob', async (original) => ({
    ...(await original<typeof TViMockOriginalModule>()),
    capturePdfRegionAsPngBlob: vi.fn(),
    freezePdfRegionCapture: () => ({
        outputRect: {
            left: 10,
            top: 10,
            right: 40,
            bottom: 40,
        },
        fragments: [],
    }),
}));
vi.mock('@app/modules/pdf-viewer/engine/pdf-region-clipboard/writePngBlobToClipboard', () => ({writePngBlobToClipboard: async (blob: Blob) => {output.clipboard = blob;}}));
function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {resolve = done;});
    return {
        promise,
        resolve,
    };
}
function createPayload(clientX: number, clientY: number): ISnipPointerPayload {
    return {
        clientX,
        clientY,
        overlayRect: {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        },
    };
}
function mountSnip() {
    let snip!: ReturnType<typeof usePdfRegionSnip>;
    const viewerContainer = document.createElement('div');
    document.body.append(viewerContainer);
    const host = document.createElement('div');
    document.body.append(host);
    const view = defineComponent({setup() {
        const controller = inject(pdfRegionSnipKeyboardKey)!;
        return () => controller.state.value === 'idle' ? null : h('div', {
            ref: element => {
                if (element instanceof Element) element.getBoundingClientRect = () => new DOMRect(10, 10, 30, 30);
                controller.setCropTarget(element instanceof Element ? element : null);
            },
            role: 'status',
        }, controller.state.value);
    }});
    const app = createApp(defineComponent({setup() {
        snip = usePdfRegionSnip({
            viewerContainer: ref(viewerContainer),
            document: {
                captureFence: () => ({
                    loadToken: 1,
                    documentVersion: 1,
                    documentRevision: null,
                    openSurfaceGeneration: 1,
                }),
                isCurrent: () => true,
                subscribe: () => () => {},
                registerDisposable: () => {},
            },
            prepare: async () => {},
            viewState: {
                viewRotation: 0,
                isActive: true,
            },
        });
        return () => h(view);
    }}));
    app.mount(host);
    async function selectAndConfirm() {
        const ready = new Promise<void>(resolve => {
            const stop = watch(snip.state, value => {if (value === 'confirming') {stop(); resolve();}}, {flush: 'sync'});
        });
        snip.onPointerStart(createPayload(10, 10));
        snip.onPointerEnd(createPayload(40, 40));
        await ready;
        await nextTick();
        snip.handleKeyboardKey(new KeyboardEvent('keydown', {key: 'Enter'}));
    }
    return {
        app,
        snip,
        selectAndConfirm,
        host,
    };
}
describe('usePdfRegionSnip', () => {
    afterEach(() => {vi.clearAllMocks(); output.clipboard = null; output.failures.length = 0; document.body.replaceChildren();});
    it('keeps the previous clipboard image and settles false after pending capture is cancelled', async () => {
        const capture = createDeferred<NonNullable<Awaited<ReturnType<typeof capturePdfRegionAsPngBlob>>>>();
        vi.mocked(capturePdfRegionAsPngBlob).mockReturnValue(capture.promise);
        const previous = new Blob(['previous PNG'], {type: 'image/png'});
        output.clipboard = previous;
        const {
            app, snip, selectAndConfirm, host,
        } = mountSnip();
        const session = snip.startCaptureSession();
        await selectAndConfirm();
        snip.cancelCapture();
        await expect(session).resolves.toBe(false);
        capture.resolve({
            blob: new Blob(['late PNG'], {type: 'image/png'}),
            outputRect: {
                left: 10,
                top: 10,
                right: 40,
                bottom: 40,
            },
        });
        await nextTick();
        await nextTick();
        expect(output.clipboard).toBe(previous);
        expect(host.textContent).not.toContain('success');
        expect(output.failures).toEqual([]);
        app.unmount();
    });
    it('settles false and presents the capture cause once without a success badge', async () => {
        vi.mocked(capturePdfRegionAsPngBlob).mockRejectedValue(new Error('capture failed'));
        const {
            app, snip, selectAndConfirm, host,
        } = mountSnip();
        const session = snip.startCaptureSession();
        await selectAndConfirm();
        await expect(session).resolves.toBe(false);
        await nextTick();
        expect(output.clipboard).toBeNull();
        expect(output.failures.map(failure => failure.technicalDetails)).toEqual(['capture failed']);
        expect(host.textContent).not.toContain('success');
        app.unmount();
    });
});
