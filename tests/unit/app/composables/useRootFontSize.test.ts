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
    nextTick,
    onMounted,
} from 'vue';
import type { Ref } from 'vue';
import {
    BASE_ROOT_FONT_SIZE_PX,
    readRootFontSizePx,
} from '@app/utils/rootFontSize';
import { useRootFontSize } from '@app/composables/useRootFontSize';

/**
 * Everything that lines rem-sized layout up with pixel arithmetic reads its rem
 * base here, so this composable has to answer with the size the document is
 * actually resolving — and keep answering after the user changes the UI scale or
 * zooms.
 */

const mounted = new Set<() => void>();

function mountWithRootFontSize() {
    const host = document.createElement('div');
    document.body.append(host);
    const captured: {rootFontSizePx: Ref<number> | null} = {rootFontSizePx: null};
    const app = createApp(defineComponent({setup() {
        captured.rootFontSizePx = useRootFontSize().rootFontSizePx;
        return () => null;
    }}));
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        mounted.delete(unmount);
    };
    mounted.add(unmount);
    if (!captured.rootFontSizePx) {
        throw new Error('useRootFontSize returned nothing');
    }
    return {
        rootFontSizePx: captured.rootFontSizePx,
        unmount,
    };
}

function setRootFontSize(cssLength: string) {
    document.documentElement.style.fontSize = cssLength;
}

afterEach(() => {
    for (const unmount of [...mounted]) {
        unmount();
    }
    document.documentElement.style.removeProperty('font-size');
    vi.unstubAllGlobals();
});

describe('readRootFontSizePx', () => {
    it('reads the size the document resolves', () => {
        setRootFontSize('20px');

        expect(readRootFontSizePx()).toBe(20);
    });

    it('falls back to the base size where nothing can be measured', () => {
        // Server-side rendering and the plain node test environment both get
        // here; a zero or missing measurement must never reach the metrics that
        // divide by it.
        vi.stubGlobal('getComputedStyle', undefined);

        expect(readRootFontSizePx()).toBe(BASE_ROOT_FONT_SIZE_PX);

        vi.stubGlobal('getComputedStyle', () => ({fontSize: '0px'}));

        expect(readRootFontSizePx()).toBe(BASE_ROOT_FONT_SIZE_PX);
    });
});

describe('useRootFontSize', () => {
    it('reports the current rem base on mount', () => {
        setRootFontSize('20px');

        expect(mountWithRootFontSize().rootFontSizePx.value).toBe(20);
    });

    it('follows a UI-scale change written onto the document element', async () => {
        setRootFontSize('16px');
        const {rootFontSizePx} = mountWithRootFontSize();

        // `applyUiScaleToDocument` (from `useUiScale.ts`) writes an inline custom property on
        // exactly this element, which is what moves the rem base at runtime.
        setRootFontSize('20px');
        await vi.waitFor(() => {
            expect(rootFontSizePx.value).toBe(20);
        });
    });

    it('follows a zoom-driven change of the rem base', async () => {
        setRootFontSize('16px');
        const {rootFontSizePx} = mountWithRootFontSize();

        // Browser and OS zoom move the *resolved* root font size while the
        // document element's own style attribute stays exactly as it was, so no
        // mutation is observable and the resize event is the only signal.
        vi.stubGlobal('getComputedStyle', () => ({fontSize: '14px'}));
        expect(rootFontSizePx.value).toBe(16);

        globalThis.dispatchEvent(new Event('resize'));
        await nextTick();

        expect(rootFontSizePx.value).toBe(14);
    });

    it('remeasures at mount, so a scale applied while the app was starting is not missed', async () => {
        setRootFontSize('16px');
        // An observer that reports nothing leaves the mount-time measurement as
        // the only way to notice the change below, which is the point: the real
        // observer only starts watching after this component has mounted.
        vi.stubGlobal('MutationObserver', class {
            disconnect() {}
            observe() {}
            takeRecords() {
                return [];
            }
        });

        const captured: {rootFontSizePx: Ref<number> | null} = {rootFontSizePx: null};
        const consumer = defineComponent({setup() {
            captured.rootFontSizePx = useRootFontSize().rootFontSizePx;
            return () => null;
        }});
        // Applying the UI scale from a mounted hook is what the app does once
        // settings have loaded, and mounted hooks run in render order.
        const scaleApplier = defineComponent({setup() {
            onMounted(() => {
                setRootFontSize('20px');
            });
            return () => null;
        }});
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup: () => () => [
            h(scaleApplier),
            h(consumer),
        ]}));
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            mounted.delete(unmount);
        };
        mounted.add(unmount);
        await nextTick();

        expect(captured.rootFontSizePx?.value).toBe(20);
    });

    it('stops measuring once the component using it is gone', async () => {
        setRootFontSize('16px');
        const {
            rootFontSizePx,
            unmount,
        } = mountWithRootFontSize();

        unmount();
        setRootFontSize('24px');
        vi.stubGlobal('getComputedStyle', () => ({fontSize: '24px'}));
        globalThis.dispatchEvent(new Event('resize'));
        await nextTick();

        expect(rootFontSizePx.value).toBe(16);
    });
});
