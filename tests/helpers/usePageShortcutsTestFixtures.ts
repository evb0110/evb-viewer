import {
    computed,
    ref,
} from 'vue';
import {vi} from 'vitest';
import type {TAnnotationTool} from '@app/types/annotations';
import type {TPdfViewMode} from '@contracts/shared';
import type {TPdfSource} from '@app/types/pdfUi';
import {
    createKeyboardEventFixture,
    type IKeyboardEventFixtureOptions,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

const pageShortcutsMocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    useMagicKeys: vi.fn(),
    tryOnScopeDispose: vi.fn(),
    whenever: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({
    useEventListener: pageShortcutsMocks.useEventListener,
    useMagicKeys: pageShortcutsMocks.useMagicKeys,
    tryOnScopeDispose: pageShortcutsMocks.tryOnScopeDispose,
    whenever: pageShortcutsMocks.whenever,
}));
vi.mock('@app/utils/shouldHandleRendererMenuAccelerators', () => ({shouldHandleRendererMenuAccelerators: pageShortcutsMocks.shouldHandleRendererMenuAccelerators}));

export function getPageShortcutsMocks() {
    return pageShortcutsMocks;
}

export function createPageShortcutDeps() {
    const pdfSrc = ref<TPdfSource | null>(new Blob([], {type: 'application/pdf'}));
    return {
        isActive: ref(true),
        // Mirrors the workspace wiring, which derives the flag from the open PDF
        // or DjVu source.
        hasInteractiveDocument: computed(() => Boolean(pdfSrc.value)),
        pdfSrc,
        canPrint: ref(true),
        canSave: ref(true),
        showSettings: ref(false),
        annotationTool: ref<TAnnotationTool>('none'),
        pdfViewerRef: ref({deleteSelectedShape: vi.fn()}),
        annotationContextMenuVisible: ref(false),
        pageContextMenuVisible: ref(false),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        openSearch: vi.fn(),
        openAnnotations: vi.fn(),
        handleAnnotationToolChange: vi.fn(),
        handleZoomIn: vi.fn(),
        handleZoomOut: vi.fn(),
        handleActualSize: vi.fn(),
        handleFitMode: vi.fn(),
        navigationPage: ref(3),
        totalPages: ref(10),
        viewMode: ref<TPdfViewMode>('single'),
        handleGoToPage: vi.fn(),
        handleSave: vi.fn(),
        handlePrint: vi.fn(),
        handleToggleSidebar: vi.fn(),
    };
}

let capturedOnEventFired: ((event: unknown) => void) | undefined;
let capturedPointerDown: ((event: PointerEvent) => void) | undefined;
let capturedKeyDown: ((event: KeyboardEvent) => void) | undefined;

export function resetPageShortcutsTest() {
    vi.resetModules();
    vi.clearAllMocks();
    const windowMock = {
        addEventListener: vi.fn((event: string, listener: EventListener) => {
            if (event === 'pointerdown') capturedPointerDown = listener;
            if (event === 'keydown') capturedKeyDown = listener;
        }),
        removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', windowMock);
    capturedOnEventFired = undefined;
    capturedPointerDown = undefined;
    capturedKeyDown = undefined;
    pageShortcutsMocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
    pageShortcutsMocks.useEventListener.mockImplementation((
        target: {addEventListener?: (...args: unknown[]) => void} | null,
        event: string,
        listener: EventListener,
        options?: AddEventListenerOptions,
    ) => {
        target?.addEventListener?.(event, listener, options);
        return vi.fn();
    });
    pageShortcutsMocks.useMagicKeys.mockImplementation((opts?: {onEventFired?: (event: unknown) => void}) => {
        capturedOnEventFired = opts?.onEventFired;
        return new Proxy({}, {get: () => ref(false)});
    });
}

export function restorePageShortcutsTest() {
    vi.unstubAllGlobals();
    capturedOnEventFired = undefined;
    capturedPointerDown = undefined;
    capturedKeyDown = undefined;
}

export function getCapturedOnEventFired() {
    return capturedOnEventFired;
}

export function getCapturedPointerDown() {
    return capturedPointerDown;
}

export function getCapturedKeyDown() {
    return capturedKeyDown;
}

export function pressPagingKey(key: string, overrides: Partial<IKeyboardEventFixtureOptions> = {}) {
    const preventDefault = vi.fn();
    if (!capturedOnEventFired) {
        throw new Error('Expected useMagicKeys to register onEventFired.');
    }
    capturedOnEventFired(createKeyboardEventFixture({
        key,
        code: key,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        target: null,
        preventDefault,
        ...overrides,
    }));
    return preventDefault;
}
