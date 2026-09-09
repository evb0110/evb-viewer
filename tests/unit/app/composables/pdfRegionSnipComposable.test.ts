// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
import type * as TViMockOriginalModule2 from '@app/modules/pdf-viewer/engine/pdf-region-clipboard/writePngBlobToClipboard';

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    ref,
} from 'vue';
import { usePdfRegionSnip } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import { capturePdfRegionAsPngBlob } from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
import { writePngBlobToClipboard } from '@app/modules/pdf-viewer/engine/pdf-region-clipboard/writePngBlobToClipboard';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';

vi.mock('@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    capturePdfRegionAsPngBlob: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/engine/pdf-region-clipboard/writePngBlobToClipboard', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    writePngBlobToClipboard: vi.fn(),
}));

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
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
    const app = createApp(defineComponent({ setup() {
        snip = usePdfRegionSnip({ viewerContainer: ref(viewerContainer) });
        return () => null;
    } }));
    app.mount(host);
    return {
        app,
        snip,
    };
}

describe('usePdfRegionSnip', () => {
    afterEach(() => {
        vi.clearAllMocks();
        document.body.replaceChildren();
    });

    it('does not write clipboard or mark success when capture is canceled before async capture resolves', async () => {
        const capture = createDeferred<NonNullable<Awaited<ReturnType<typeof capturePdfRegionAsPngBlob>>>>();
        vi.mocked(capturePdfRegionAsPngBlob).mockReturnValue(capture.promise);
        vi.mocked(writePngBlobToClipboard).mockResolvedValue(undefined);
        const {
            app,
            snip,
        } = mountSnip();

        const session = snip.startCaptureSession();
        snip.onPointerStart(createPayload(10, 10));
        snip.onPointerEnd(createPayload(40, 40));
        expect(snip.state.value).toBe('copying');

        snip.cancelCapture();
        await expect(session).resolves.toBe(false);
        capture.resolve({
            blob: new Blob(['ok'], { type: 'image/png' }),
            outputRect: {
                left: 10,
                top: 10,
                right: 40,
                bottom: 40,
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(writePngBlobToClipboard).not.toHaveBeenCalled();
        expect(snip.state.value).toBe('idle');

        app.unmount();
    });

    it('keeps error state visible after async capture failures settle the session', async () => {
        vi.mocked(capturePdfRegionAsPngBlob).mockRejectedValue(new Error('capture failed'));
        const {
            app,
            snip,
        } = mountSnip();

        const session = snip.startCaptureSession();
        snip.onPointerStart(createPayload(10, 10));
        snip.onPointerEnd(createPayload(40, 40));

        await expect(session).resolves.toBe(false);
        expect(snip.state.value).toBe('error');

        app.unmount();
    });
});
