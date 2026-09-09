// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

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
    h,
    nextTick,
    ref,
} from 'vue';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';
import PdfImagePlacementOverlay from '@app/modules/pdf-viewer/components/PdfImagePlacementOverlay.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const placement: IPdfImagePlacementDraft = {
    stableKey: 'placed-image-draft',
    viewRotation: 0,
    pageNumber: 1,
    x: 0.2,
    y: 0.25,
    width: 0.3,
    height: 0.2,
    rotationDegrees: 15,
    previewUrl: 'blob:image-placement-preview',
    fileName: 'stamp.jpg',
    mimeType: 'image/jpeg',
    sourcePixelWidth: 300,
    sourcePixelHeight: 200,
    bytes: new Uint8Array([
        1,
        2,
        3,
    ]),
};

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

function mountOverlay(busy = false, echoRectangleUpdates = false) {
    const host = document.createElement('div');
    document.body.append(host);
    const currentPlacement = ref(placement);
    const updates: IPdfImagePlacementRectUpdate[] = [];
    const events = {
        cancel: 0,
        finalize: 0,
    };
    const app = createApp(defineComponent({setup: () => () => h(PdfImagePlacementOverlay, {
        placement: currentPlacement.value,
        busy,
        onUpdateRect: (update: IPdfImagePlacementRectUpdate) => {
            updates.push(update);
            if (echoRectangleUpdates) {
                currentPlacement.value = {
                    ...currentPlacement.value,
                    ...update,
                };
            }
        },
        onCancel: () => {
            events.cancel += 1;
        },
        onFinalize: () => {
            events.finalize += 1;
        },
    })}));
    app.mount(host);

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        events,
        host,
        updates,
        currentPlacement,
        unmount,
    };
}

const gestureHandles = [
    [
        'move',
        '.pdf-image-placement__surface',
    ],
    [
        'resize',
        '.pdf-image-placement__resizer--se',
    ],
    [
        'rotate',
        '.pdf-image-placement__rotate-handle',
    ],
] as const;

async function completeImageGesture(selector: string, ending: 'pointerup' | 'lostpointercapture' | 'pointercancel', buttons = 0) {
    const overlay = mountOverlay(false, true);
    const frame = overlay.host.querySelector<HTMLElement>('.pdf-image-placement')!;
    vi.spyOn(frame.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 800));
    const handle = overlay.host.querySelector<HTMLElement>(selector)!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => false);
    handle.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        buttons: 1,
        clientX: 200,
        clientY: 300,
        bubbles: true,
    }));
    await nextTick();
    window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        button: -1,
        buttons: 1,
        clientX: 225,
        clientY: 325,
    }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await nextTick();
    const preview = overlay.updates.at(-1);
    expect(preview).toBeDefined();

    // Leave a move queued when capture disappears. Completion must consume the
    // release coordinates, and cancellation must discard the queued update.
    const releasePoint = {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 260,
        clientY: 350,
    };
    window.dispatchEvent(new PointerEvent('pointermove', {
        ...releasePoint,
        button: -1,
        buttons: 1,
    }));
    window.dispatchEvent(new PointerEvent(ending, {
        ...releasePoint,
        button: ending === 'pointerup' ? 0 : -1,
        buttons,
    }));
    await nextTick();
    const final = overlay.updates.at(-1);
    const updateCount = overlay.updates.length;
    window.dispatchEvent(new PointerEvent('pointermove', {
        ...releasePoint,
        button: -1,
        buttons: 0,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
        ...releasePoint,
        button: 0,
        buttons: 0,
    }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await nextTick();
    expect(overlay.updates).toHaveLength(updateCount);
    expect(document.documentElement.hasAttribute('data-pdf-image-placement-cursor')).toBe(false);
    expect(overlay.events).toEqual({
        cancel: 0,
        finalize: 0,
    });
    overlay.unmount();
    return {
        preview,
        final,
    };
}

describe('PdfImagePlacementOverlay', () => {
    it.each(gestureHandles)('finishes %s at released-mouse capture loss before pointerup', async (_mode, selector) => {
        const normal = await completeImageGesture(selector, 'pointerup');
        const lostCapture = await completeImageGesture(selector, 'lostpointercapture');
        expect(normal.final).not.toEqual(normal.preview);
        expect(lostCapture.final).toEqual(normal.final);
    });

    it.each(gestureHandles)('rolls back %s on genuine cancellation or capture loss while held', async (_mode, selector) => {
        for (const ending of [
            'pointercancel',
            'lostpointercapture',
        ] as const) {
            const result = await completeImageGesture(selector, ending, ending === 'pointercancel' ? 0 : 1);
            expect(result.final).not.toEqual(result.preview);
            expect(result.final).toEqual({
                x: placement.x,
                y: placement.y,
                width: placement.width,
                height: placement.height,
                rotationDegrees: placement.rotationDegrees,
            });
        }
    });

    it('renders the pending image and routes placement actions', () => {
        const {
            events,
            host,
        } = mountOverlay();

        const image = host.querySelector<HTMLImageElement>('.pdf-image-placement__preview');
        expect(image?.getAttribute('src')).toBe(placement.previewUrl);
        expect(image?.getAttribute('alt')).toBe(placement.fileName);
        expect(host.querySelector('.pdf-image-placement')?.getAttribute('style')).toContain('width: 30%');

        const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
        buttons.find(button => button.textContent?.includes('cancelImagePlacement'))?.click();
        buttons.find(button => button.textContent?.includes('embedImageToPage'))?.click();

        expect(events.cancel).toBe(1);
        expect(events.finalize).toBe(1);
    });

    it('disables placement controls while the editor finalizes the image', () => {
        const {host} = mountOverlay(true);

        const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.every(button => button.disabled)).toBe(true);
    });
    it('rolls a canceled pointer gesture back to the original image rectangle', async () => {
        const {
            host,
            updates,
        } = mountOverlay();
        const frame = host.querySelector<HTMLElement>('.pdf-image-placement')!;
        vi.spyOn(frame.parentElement!, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            width: 600,
            height: 800,
        } as DOMRect);
        const handle = host.querySelector<HTMLElement>('.pdf-image-placement__surface')!;
        handle.setPointerCapture = vi.fn();
        handle.hasPointerCapture = vi.fn(() => false);
        handle.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1,
            button: 0,
            clientX: 200,
            clientY: 300,
            bubbles: true,
        }));
        await nextTick();
        window.dispatchEvent(new PointerEvent('pointercancel', {
            pointerId: 1,
            clientX: 500,
            clientY: 600,
        }));
        expect(updates).toEqual([{
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
            rotationDegrees: placement.rotationDegrees,
        }]);
        expect(document.documentElement.hasAttribute('data-pdf-image-placement-cursor')).toBe(false);
    });

    it('ends the old drag when a new placement replaces it', async () => {
        const {
            host,
            updates,
            currentPlacement,
        } = mountOverlay();
        const frame = host.querySelector<HTMLElement>('.pdf-image-placement')!;
        vi.spyOn(frame.parentElement!, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            width: 600,
            height: 800,
        } as DOMRect);
        const handle = host.querySelector<HTMLElement>('.pdf-image-placement__surface')!;
        handle.setPointerCapture = vi.fn();
        handle.hasPointerCapture = vi.fn(() => false);
        handle.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1,
            button: 0,
            clientX: 200,
            clientY: 300,
            bubbles: true,
        }));
        await nextTick();
        currentPlacement.value = {
            ...placement,
            previewUrl: 'blob:new-image',
        };
        await nextTick();
        window.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1,
            clientX: 500,
            clientY: 600,
        }));
        expect(updates).toEqual([]);
        expect(document.documentElement.hasAttribute('data-pdf-image-placement-cursor')).toBe(false);
    });

    it('continues a drag when the parent echoes each rectangle update through props', async () => {
        const {
            host,
            updates,
            currentPlacement,
        } = mountOverlay(false, true);
        const frame = host.querySelector<HTMLElement>('.pdf-image-placement')!;
        vi.spyOn(frame.parentElement!, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            width: 600,
            height: 800,
        } as DOMRect);
        const handle = host.querySelector<HTMLElement>('.pdf-image-placement__surface')!;
        handle.setPointerCapture = vi.fn();
        handle.hasPointerCapture = vi.fn(() => false);
        handle.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1,
            button: 0,
            clientX: 200,
            clientY: 300,
            bubbles: true,
        }));
        await nextTick();
        for (let step = 1; step <= 8; step += 1) {
            window.dispatchEvent(new PointerEvent('pointermove', {
                pointerId: 1,
                clientX: 200 + step * 6,
                clientY: 300 + step * 4,
            }));
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            await nextTick();
        }
        window.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1,
            clientX: 248,
            clientY: 332,
        }));
        await nextTick();
        expect(updates.length).toBeGreaterThanOrEqual(8);
        expect(currentPlacement.value.x).toBeCloseTo(placement.x + 48 / 600);
        expect(currentPlacement.value.y).toBeCloseTo(placement.y + 32 / 800);
    });

});
