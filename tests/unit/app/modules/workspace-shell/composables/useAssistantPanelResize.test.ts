// @vitest-environment happy-dom

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createApp, defineComponent, h} from 'vue';
import {useAssistantPanelResize} from '@app/modules/workspace-shell/composables/useAssistantPanelResize';

const PANEL_WIDTH_STORAGE_KEY = 'evb-viewer:assistant:panel-width';

let unmountHost: (() => void) | null = null;

function mountPanelResize() {
    let api: ReturnType<typeof useAssistantPanelResize> | null = null;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(
        defineComponent({
            setup: () => {
                api = useAssistantPanelResize();
                return () => h('div');
            },
        }),
    );
    app.mount(host);
    unmountHost = () => {
        app.unmount();
        host.remove();
        unmountHost = null;
    };
    return api!;
}

function pointerEvent(type: string, clientX: number) {
    return new PointerEvent(type, {clientX});
}

async function nextFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    unmountHost?.();
});

describe('useAssistantPanelResize', () => {
    it('starts at the default width without resizing', () => {
        const api = mountPanelResize();
        expect(api.panelWidth.value).toBe(384);
        expect(api.isResizingPanel.value).toBe(false);
    });

    it('grows on a leftward drag and stops tracking after pointerup', async () => {
        const api = mountPanelResize();
        api.startPanelResize(pointerEvent('pointerdown', 800));
        expect(api.isResizingPanel.value).toBe(true);

        window.dispatchEvent(pointerEvent('pointermove', 750));
        await nextFrame();
        expect(api.panelWidth.value).toBe(434);

        window.dispatchEvent(pointerEvent('pointerup', 720));
        expect(api.panelWidth.value).toBe(464);
        expect(api.isResizingPanel.value).toBe(false);

        // The drag detaches its window listeners, so later movement is inert.
        window.dispatchEvent(pointerEvent('pointermove', 300));
        await nextFrame();
        expect(api.panelWidth.value).toBe(464);
    });

    it('clamps drag results to the allowed range', () => {
        const api = mountPanelResize();
        api.startPanelResize(pointerEvent('pointerdown', 800));
        window.dispatchEvent(pointerEvent('pointerup', 200));
        expect(api.panelWidth.value).toBe(560);

        api.startPanelResize(pointerEvent('pointerdown', 800));
        window.dispatchEvent(pointerEvent('pointerup', 1400));
        expect(api.panelWidth.value).toBe(320);
    });

    it('drops a queued move frame when pointerup lands before it fires', async () => {
        const api = mountPanelResize();
        api.startPanelResize(pointerEvent('pointerdown', 800));
        window.dispatchEvent(pointerEvent('pointermove', 750));
        window.dispatchEvent(pointerEvent('pointerup', 720));
        expect(api.panelWidth.value).toBe(464);
        // Stopping flushes the final position and cancels the queued frame,
        // so the earlier 750 move (which would yield 434) never lands.
        await nextFrame();
        expect(api.panelWidth.value).toBe(464);
    });

    it('detaches drag listeners when the host unmounts mid-drag', async () => {
        const api = mountPanelResize();
        api.startPanelResize(pointerEvent('pointerdown', 800));
        unmountHost?.();
        window.dispatchEvent(pointerEvent('pointermove', 700));
        await nextFrame();
        expect(api.panelWidth.value).toBe(384);
    });

    it('cancels a drag on pointercancel', async () => {
        const api = mountPanelResize();
        api.startPanelResize(pointerEvent('pointerdown', 800));
        window.dispatchEvent(pointerEvent('pointercancel', 700));
        expect(api.isResizingPanel.value).toBe(false);
        window.dispatchEvent(pointerEvent('pointermove', 200));
        await nextFrame();
        expect(api.panelWidth.value).toBe(484);
    });

    it('normalizes an out-of-bounds persisted width on mount', () => {
        localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, '9999');
        const api = mountPanelResize();
        expect(api.panelWidth.value).toBe(560);
    });
});
