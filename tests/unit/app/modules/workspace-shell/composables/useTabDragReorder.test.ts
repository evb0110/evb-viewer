// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    ref,
} from 'vue';

const mocks = vi.hoisted(() => ({useEventListener: vi.fn()}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
    };
}

function pointerEvent(init: Partial<PointerEvent> & { currentTarget?: EventTarget | null }): PointerEvent {
    return init as PointerEvent;
}

// happy-dom's style declaration rejects property redefinition, so a setter spy
// cannot be installed on it. Observe writes through a forwarding proxy instead.
function spyOnTransformWrites(element: HTMLElement) {
    const writes = vi.fn();
    const style = new Proxy(element.style, {set(target, property, value) {
        if (property === 'transform') {
            writes(value);
        }
        return Reflect.set(target, property, value);
    }});
    Object.defineProperty(element, 'style', {value: style});
    return writes;
}

describe('useTabDragReorder', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    it('uses a fixed body drag preview while preserving cross-pane move detection', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });

        const container = document.createElement('div');
        container.getBoundingClientRect = vi.fn(() => rect(100, 10, 200, 32));

        const firstTab = document.createElement('button');
        firstTab.dataset.tabId = 'tab-1';
        firstTab.textContent = 'Document tab';
        firstTab.getBoundingClientRect = vi.fn(() => rect(100, 10, 80, 32));
        firstTab.setPointerCapture = vi.fn();

        const secondTab = document.createElement('button');
        secondTab.dataset.tabId = 'tab-2';
        secondTab.textContent = 'Other tab';
        secondTab.getBoundingClientRect = vi.fn(() => rect(180, 10, 80, 32));

        const targetList = document.createElement('div');
        targetList.dataset.tabList = 'true';
        targetList.getBoundingClientRect = vi.fn(() => rect(320, 10, 200, 32));
        const targetFirstTab = document.createElement('button');
        targetFirstTab.dataset.tabId = 'tab-3';
        targetFirstTab.getBoundingClientRect = vi.fn(() => rect(320, 10, 80, 32));
        const targetSecondTab = document.createElement('button');
        targetSecondTab.dataset.tabId = 'tab-4';
        targetSecondTab.getBoundingClientRect = vi.fn(() => rect(400, 10, 80, 32));
        targetList.append(targetFirstTab, targetSecondTab);

        container.append(firstTab, secondTab);
        document.body.append(container, targetList);

        const onReorder = vi.fn();
        const onDragStart = vi.fn();
        const onMoveToDirection = vi.fn();
        const { useTabDragReorder } = await import('@app/modules/workspace-shell/composables/useTabDragReorder');
        let drag!: ReturnType<typeof useTabDragReorder>;
        const appHost = document.createElement('div');
        document.body.append(appHost);
        const app = createApp({setup() {
            drag = useTabDragReorder(
                ref(container),
                onReorder,
                onDragStart,
                onMoveToDirection,
            );
            return () => null;
        }});
        app.mount(appHost);

        drag.onPointerDown(pointerEvent({
            button: 0,
            clientX: 120,
            clientY: 20,
            currentTarget: firstTab,
            pointerId: 1,
        }), 0);

        handlers.get('pointermove')?.(pointerEvent({
            clientX: 340,
            clientY: 80,
        }));

        const preview = document.body.querySelector<HTMLElement>('[data-tab-drag-preview="true"]');
        expect(preview).not.toBeNull();
        expect(preview?.parentElement).toBe(document.body);
        expect(preview?.style.position).toBe('fixed');
        expect(preview?.style.zIndex).toBe('2147483647');
        expect(preview?.style.pointerEvents).toBe('none');
        expect(preview?.style.transform).toBe('translate3d(220px, 0, 0)');
        expect(firstTab.style.visibility).toBe('hidden');
        expect(targetFirstTab.style.transform).toBe('translateX(80px)');
        expect(targetSecondTab.style.transform).toBe('translateX(80px)');
        expect(onDragStart).toHaveBeenCalledWith(0);

        handlers.get('pointerup')?.(pointerEvent({clientX: 340}));

        expect(onMoveToDirection).toHaveBeenCalledWith(0, 'right', 0);
        expect(onReorder).not.toHaveBeenCalled();
        expect(targetFirstTab.style.transform).toBe('');
        expect(targetSecondTab.style.transform).toBe('');
        expect(document.body.querySelector('[data-tab-drag-preview="true"]')).toBeNull();
        expect(firstTab.style.visibility).toBe('');
        app.unmount();
    });

    it('does not restart destination-pane shifts while hovering over the same insertion slot', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });

        const container = document.createElement('div');
        container.getBoundingClientRect = vi.fn(() => rect(100, 10, 200, 32));

        const firstTab = document.createElement('button');
        firstTab.dataset.tabId = 'tab-1';
        firstTab.getBoundingClientRect = vi.fn(() => rect(100, 10, 80, 32));
        firstTab.setPointerCapture = vi.fn();

        const secondTab = document.createElement('button');
        secondTab.dataset.tabId = 'tab-2';
        secondTab.getBoundingClientRect = vi.fn(() => rect(180, 10, 80, 32));

        const targetList = document.createElement('div');
        targetList.dataset.tabList = 'true';
        targetList.getBoundingClientRect = vi.fn(() => rect(320, 10, 200, 32));
        const targetFirstTab = document.createElement('button');
        targetFirstTab.dataset.tabId = 'tab-3';
        targetFirstTab.getBoundingClientRect = vi.fn(() => rect(320, 10, 80, 32));
        const targetSecondTab = document.createElement('button');
        targetSecondTab.dataset.tabId = 'tab-4';
        targetSecondTab.getBoundingClientRect = vi.fn(() => rect(400, 10, 80, 32));
        targetList.append(targetFirstTab, targetSecondTab);

        const firstTargetTransform = spyOnTransformWrites(targetFirstTab);
        const secondTargetTransform = spyOnTransformWrites(targetSecondTab);

        container.append(firstTab, secondTab);
        document.body.append(container, targetList);

        const onReorder = vi.fn();
        const onMoveToDirection = vi.fn();
        const { useTabDragReorder } = await import('@app/modules/workspace-shell/composables/useTabDragReorder');
        let drag!: ReturnType<typeof useTabDragReorder>;
        const appHost = document.createElement('div');
        document.body.append(appHost);
        const app = createApp({setup() {
            drag = useTabDragReorder(
                ref(container),
                onReorder,
                undefined,
                onMoveToDirection,
            );
            return () => null;
        }});
        app.mount(appHost);

        drag.onPointerDown(pointerEvent({
            button: 0,
            clientX: 120,
            currentTarget: firstTab,
            pointerId: 1,
        }), 0);

        handlers.get('pointermove')?.(pointerEvent({clientX: 340}));
        handlers.get('pointermove')?.(pointerEvent({clientX: 342}));

        expect(targetFirstTab.style.transform).toBe('translateX(80px)');
        expect(targetSecondTab.style.transform).toBe('translateX(80px)');
        expect(firstTargetTransform).toHaveBeenCalledTimes(1);
        expect(secondTargetTransform).toHaveBeenCalledTimes(1);

        handlers.get('pointerup')?.(pointerEvent({clientX: 342}));

        expect(onMoveToDirection).toHaveBeenCalledWith(0, 'right', 0);
        expect(onReorder).not.toHaveBeenCalled();
        app.unmount();
    });

    it('keeps same-pane reorder and click suppression working with the fixed preview', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });

        const container = document.createElement('div');
        container.getBoundingClientRect = vi.fn(() => rect(100, 10, 200, 32));

        const firstTab = document.createElement('button');
        firstTab.dataset.tabId = 'tab-1';
        firstTab.textContent = 'Document tab';
        firstTab.getBoundingClientRect = vi.fn(() => rect(100, 10, 80, 32));
        firstTab.setPointerCapture = vi.fn();

        const secondTab = document.createElement('button');
        secondTab.dataset.tabId = 'tab-2';
        secondTab.textContent = 'Other tab';
        secondTab.getBoundingClientRect = vi.fn(() => rect(180, 10, 80, 32));

        container.append(firstTab, secondTab);
        document.body.append(container);

        const onReorder = vi.fn();
        const onMoveToDirection = vi.fn();
        const { useTabDragReorder } = await import('@app/modules/workspace-shell/composables/useTabDragReorder');
        let drag!: ReturnType<typeof useTabDragReorder>;
        const appHost = document.createElement('div');
        document.body.append(appHost);
        const app = createApp({setup() {
            drag = useTabDragReorder(
                ref(container),
                onReorder,
                undefined,
                onMoveToDirection,
            );
            return () => null;
        }});
        app.mount(appHost);

        drag.onPointerDown(pointerEvent({
            button: 0,
            clientX: 120,
            currentTarget: firstTab,
            pointerId: 1,
        }), 0);

        handlers.get('pointermove')?.(pointerEvent({clientX: 230}));

        expect(secondTab.style.transform).toBe('translateX(-80px)');

        handlers.get('pointerup')?.(pointerEvent({clientX: 230}));

        expect(onReorder).toHaveBeenCalledWith(0, 1);
        expect(onMoveToDirection).not.toHaveBeenCalled();
        expect(secondTab.style.transform).toBe('');
        expect(document.body.querySelector('[data-tab-drag-preview="true"]')).toBeNull();
        expect(drag.shouldSuppressClick()).toBe(true);
        app.unmount();
    });
});
