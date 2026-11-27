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
    shouldHandleRendererMenuAccelerators: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({useEventListener: pageShortcutsMocks.useEventListener}));
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
        handleInsertImageFromFile: vi.fn(),
        handlePasteImageFromClipboard: vi.fn(),
        handlePasteImageFile: vi.fn(),
    };
}

let capturedOnEventFired: ((event: KeyboardEvent) => void) | undefined;
let capturedPointerDown: ((event: PointerEvent) => void) | undefined;
let capturedKeyDown: ((event: KeyboardEvent) => void) | undefined;
let capturedPaste: ((event: ClipboardEvent) => void) | undefined;

export function resetPageShortcutsTest() {
    vi.resetModules();
    vi.clearAllMocks();
    const windowMock = {
        addEventListener: vi.fn((event: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
            if (event === 'pointerdown') {capturedPointerDown = listener as (event: PointerEvent) => void;}
            if (event === 'keydown') {
                const isCapture = typeof options === 'boolean' ? options : Boolean(options?.capture);
                if (isCapture) {
                    capturedKeyDown = listener as (event: KeyboardEvent) => void;
                } else {
                    capturedOnEventFired = listener as (event: KeyboardEvent) => void;
                }
            }
            if (event === 'paste') {capturedPaste = listener as (event: ClipboardEvent) => void;}
        }),
        removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', windowMock);
    capturedOnEventFired = undefined;
    capturedPointerDown = undefined;
    capturedKeyDown = undefined;
    capturedPaste = undefined;
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
}

export function restorePageShortcutsTest() {
    vi.unstubAllGlobals();
    capturedOnEventFired = undefined;
    capturedPointerDown = undefined;
    capturedKeyDown = undefined;
    capturedPaste = undefined;
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

export function getCapturedPaste() {
    return capturedPaste;
}

export function pressShortcut(
    key: string,
    overrides: Partial<IKeyboardEventFixtureOptions> = {},
    listener: ((event: KeyboardEvent) => void) | undefined = capturedOnEventFired,
) {
    const preventDefault = vi.fn();
    if (!listener) {
        throw new Error('Expected a keyboard event listener.');
    }
    listener(createKeyboardEventFixture({
        key,
        preventDefault,
        ...overrides,
    }));
    return preventDefault;
}
