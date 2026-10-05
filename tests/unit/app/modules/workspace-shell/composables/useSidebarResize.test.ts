import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { SIDEBAR } from '@app/constants/pdfLayout';

const mocks = vi.hoisted(() => ({useEventListener: vi.fn()}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    warn: vi.fn(),
}}));

interface IPointerEventFixtureOptions {
    clientX?: number;
    preventDefault?: () => void;
}

function createPointerEventFixture(options: IPointerEventFixtureOptions = {}): PointerEvent {
    const event = new Event('pointermove', {cancelable: true});
    Object.defineProperty(event, 'clientX', {
        configurable: true,
        value: options.clientX ?? 0,
    });
    if (options.preventDefault) {
        Object.defineProperty(event, 'preventDefault', {
            configurable: true,
            value: options.preventDefault,
        });
    }

    // happy-dom does not provide the PointerEvent shape used by the resize composable.
    return event as PointerEvent;
}

describe('useSidebarResize', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
    });

    it('clamps the sidebar at the minimum width instead of closing it', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        const cleanups = [
            vi.fn(),
            vi.fn(),
            vi.fn(),
        ];

        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return cleanups.shift() ?? vi.fn();
        });

        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });

        resize.startSidebarResize(createPointerEventFixture({
            clientX: 400,
            preventDefault: vi.fn(),
        }));

        handlers.get('pointermove')?.(createPointerEventFixture({clientX: 0}));

        expect(resize.sidebarWidth.value).toBe(SIDEBAR.MIN_WIDTH);
        expect(showSidebar.value).toBe(true);
        expect(resize.isResizingSidebar.value).toBe(true);

        handlers.get('pointerup')?.(createPointerEventFixture());

        expect(resize.isResizingSidebar.value).toBe(false);
    });

    it('clamps the sidebar at the maximum width during drag', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });

        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });

        resize.startSidebarResize(createPointerEventFixture({
            clientX: 400,
            preventDefault: vi.fn(),
        }));

        handlers.get('pointermove')?.(createPointerEventFixture({clientX: 10_000}));

        expect(resize.sidebarWidth.value).toBe(SIDEBAR.MAX_WIDTH);
        expect(resize.sidebarWrapperStyle.value.width).toBe(`${SIDEBAR.MAX_WIDTH + SIDEBAR.RESIZER_WIDTH}px`);
    });

    it('preserves viewer space when possible without collapsing the sidebar below its readable minimum', async () => {
        const showSidebar = ref(true);
        const {
            resolveSidebarEffectiveMaxWidth,
            useSidebarResize,
        } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });
        resize.setSidebarContainerWidth(760);

        expect(resolveSidebarEffectiveMaxWidth(760)).toBe(440);
        expect(resize.effectiveMaxWidth.value).toBe(440);
        expect(resolveSidebarEffectiveMaxWidth(400)).toBe(SIDEBAR.MIN_WIDTH);
    });

    it('restores the tab-owned width without snapping back on reopen', async () => {
        const showSidebar = ref(false);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({
            showSidebar,
            initialWidth: 396,
        });

        expect(resize.sidebarWidth.value).toBe(396);

        showSidebar.value = true;
        await nextTick();

        expect(resize.sidebarWidth.value).toBe(396);
    });

    it('keeps the requested width when a hidden tab reports zero width, then restores it', async () => {
        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({
            showSidebar,
            initialWidth: 372,
        });
        resize.setSidebarContainerWidth(900);

        resize.setSidebarContainerWidth(0);
        expect(resize.sidebarWidth.value).toBe(372);
        expect(resize.sidebarContentWidth.value).toBe(SIDEBAR.MIN_WIDTH);

        resize.setSidebarContainerWidth(900);
        expect(resize.sidebarWidth.value).toBe(372);
        expect(resize.sidebarContentWidth.value).toBe(372);
        expect(resize.sidebarWrapperStyle.value.width).toBe(`${372 + SIDEBAR.RESIZER_WIDTH}px`);
    });

    it('restores the requested width after a narrow pane widens, including across close and reopen', async () => {
        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({
            showSidebar,
            initialWidth: 372,
        });
        const narrowMax = 600 - SIDEBAR.MIN_VIEWER_WIDTH;

        resize.setSidebarContainerWidth(600);
        expect(resize.sidebarContentWidth.value).toBe(Math.min(372, Math.max(SIDEBAR.MIN_WIDTH, narrowMax)));

        showSidebar.value = false;
        await nextTick();
        showSidebar.value = true;
        await nextTick();
        resize.setSidebarContainerWidth(1200);

        expect(resize.sidebarWidth.value).toBe(372);
        expect(resize.sidebarContentWidth.value).toBe(372);
    });

    it('starts a drag from the presented width of a constrained sidebar', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });

        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({
            showSidebar,
            initialWidth: SIDEBAR.MAX_WIDTH,
        });
        resize.setSidebarContainerWidth(760);
        const presentedWidth = resize.sidebarContentWidth.value;

        resize.startSidebarResize(createPointerEventFixture({
            clientX: 400,
            preventDefault: vi.fn(),
        }));
        handlers.get('pointermove')?.(createPointerEventFixture({clientX: 390}));

        expect(resize.sidebarWidth.value).toBe(presentedWidth - 10);
        expect(resize.sidebarContentWidth.value).toBe(presentedWidth - 10);
    });

    it('keeps the preferred width when a constrained sidebar is pressed and released without moving', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });
        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({
            showSidebar,
            initialWidth: 372,
        });
        resize.setSidebarContainerWidth(SIDEBAR.MIN_VIEWER_WIDTH + SIDEBAR.MIN_WIDTH);

        resize.startSidebarResize(createPointerEventFixture({
            clientX: 400,
            preventDefault: vi.fn(),
        }));
        handlers.get('pointerup')?.(createPointerEventFixture({clientX: 400}));
        resize.setSidebarContainerWidth(1200);

        expect(resize.sidebarContentWidth.value).toBe(372);
    });

    it('ignores resize starts while the sidebar is closed', async () => {
        const showSidebar = ref(false);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });
        const preventDefault = vi.fn();

        resize.startSidebarResize(createPointerEventFixture({
            clientX: 400,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(resize.isResizingSidebar.value).toBe(false);
        expect(resize.sidebarWidth.value).toBe(SIDEBAR.DEFAULT_WIDTH);
    });

    it('reports a resize only while the host slides the sidebar, never for the toggle itself', async () => {
        const showSidebar = ref(false);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });

        showSidebar.value = true;
        await nextTick();

        expect(resize.isResizingSidebar.value).toBe(false);

        resize.isSlidingSidebar.value = true;
        expect(resize.isResizingSidebar.value).toBe(true);
        expect(resize.isPointerResizingSidebar.value).toBe(false);

        resize.isSlidingSidebar.value = false;
        showSidebar.value = false;
        await nextTick();

        expect(resize.isResizingSidebar.value).toBe(false);
    });
});
