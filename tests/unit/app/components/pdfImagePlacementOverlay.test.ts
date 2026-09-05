// @vitest-environment happy-dom

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
} from 'vue';
import type {IPdfImagePlacementDraft} from '@app/types/pdfImagePlacement';
import PdfImagePlacementOverlay from '@app/modules/pdf-viewer/components/PdfImagePlacementOverlay.vue';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const placement: IPdfImagePlacementDraft = {
    stableKey: 'placed-image-draft',
    pageNumber: 1,
    x: 0.2,
    y: 0.25,
    width: 0.3,
    height: 0.2,
    rotationDegrees: 15,
    previewUrl: 'blob:image-placement-preview',
    fileName: 'stamp.jpg',
    mimeType: 'image/jpeg',
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

function mountOverlay(busy = false) {
    const host = document.createElement('div');
    document.body.append(host);
    const events = {
        cancel: 0,
        finalize: 0,
    };
    const app = createApp(defineComponent({setup: () => () => h(PdfImagePlacementOverlay, {
        placement,
        busy,
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
    };
}

describe('PdfImagePlacementOverlay', () => {
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
});
