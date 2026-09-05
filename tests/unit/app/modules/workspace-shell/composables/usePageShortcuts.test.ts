import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TPdfViewMode } from '@contracts/shared';
import type { TPdfSource } from '@app/types/pdfUi';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    useMagicKeys: vi.fn(),
    tryOnScopeDispose: vi.fn(),
    whenever: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({
    useEventListener: mocks.useEventListener,
    useMagicKeys: mocks.useMagicKeys,
    tryOnScopeDispose: mocks.tryOnScopeDispose,
    whenever: mocks.whenever,
}));
vi.mock('@app/utils/shouldHandleRendererMenuAccelerators', () => ({ shouldHandleRendererMenuAccelerators: mocks.shouldHandleRendererMenuAccelerators }));

function createDeps() {
    const pdfSrc = ref<TPdfSource | null>(new Blob([], { type: 'application/pdf' }));
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
        shapePropertiesPopoverVisible: ref(false),
        annotationContextMenuVisible: ref(false),
        pageContextMenuVisible: ref(false),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        closeShapeProperties: vi.fn(),
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

let capturedOnEventFired: ((e: unknown) => void) | undefined;
let capturedPointerDown: ((e: PointerEvent) => void) | undefined;
let capturedKeyDown: ((e: KeyboardEvent) => void) | undefined;

describe('usePageShortcuts', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        const windowMock = {
            addEventListener: vi.fn((event: string, listener: EventListener) => {
                if (event === 'pointerdown') {
                    capturedPointerDown = listener;
                }
                if (event === 'keydown') {
                    capturedKeyDown = listener;
                }
            }),
            removeEventListener: vi.fn(),
        };
        vi.stubGlobal('window', windowMock);
        capturedPointerDown = undefined;
        capturedKeyDown = undefined;
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        mocks.useEventListener.mockImplementation((
            target: { addEventListener?: (...args: unknown[]) => void } | null,
            event: string,
            listener: EventListener,
            options?: AddEventListenerOptions,
        ) => {
            target?.addEventListener?.(event, listener, options);
            return vi.fn();
        });

        mocks.useMagicKeys.mockImplementation((opts?: { onEventFired?: (e: unknown) => void }) => {
            capturedOnEventFired = opts?.onEventFired;
            return new Proxy({}, { get: () => ref(false) });
        });
    });

    it('registers pointerdown listener on window', async () => {
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(createDeps());

        expect(mocks.useEventListener).toHaveBeenCalledWith(
            window, 'pointerdown', expect.any(Function),
        );
        expect(mocks.useEventListener).toHaveBeenCalledWith(
            window,
            'keydown', expect.any(Function), { capture: true },
        );
    });

    it('skips pointerdown listener when window is unavailable', async () => {
        vi.stubGlobal('window', undefined);
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(createDeps());

        expect(mocks.useEventListener).toHaveBeenCalledWith(
            null, 'pointerdown', expect.any(Function),
        );
        expect(mocks.useEventListener).toHaveBeenCalledWith(
            null, 'keydown', expect.any(Function), { capture: true },
        );
    });

    it('handles zoom shortcuts via onEventFired when not Electron', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventZoomIn = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '=',
            code: 'Equal',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventZoomIn,
        }));
        expect(preventZoomIn).toHaveBeenCalledOnce();
        expect(deps.handleZoomIn).toHaveBeenCalledOnce();

        const preventZoomOut = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '-',
            code: 'Minus',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventZoomOut,
        }));
        expect(preventZoomOut).toHaveBeenCalledOnce();
        expect(deps.handleZoomOut).toHaveBeenCalledOnce();

        const preventActualSize = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '0',
            code: 'Digit0',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventActualSize,
        }));
        expect(preventActualSize).toHaveBeenCalledOnce();
        expect(deps.handleActualSize).toHaveBeenCalledOnce();
    });

    it('intercepts Cmd/Ctrl+P in the web app and routes it to print', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('routes Cmd/Ctrl+P for printable non-PDF documents without pdfSrc', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        deps.pdfSrc.value = null;
        deps.canPrint.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('does not route Cmd/Ctrl+P when the active document cannot print', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        deps.canPrint.value = false;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handlePrint).not.toHaveBeenCalled();
    });

    it('intercepts Cmd/Ctrl+S in the web app and routes it to save', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('routes web Cmd/Ctrl+S to save while focus is inside editable annotation UI', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: fakeInput,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('captures web Cmd/Ctrl+S before editable controls can swallow it', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: { nodeName: 'TEXTAREA' },
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('captures web Cmd/Ctrl+P before editable controls can swallow it', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: { nodeName: 'TEXTAREA' },
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('does not capture Cmd/Ctrl+S in Electron where the menu accelerator owns save', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: { nodeName: 'TEXTAREA' },
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('prevents browser save but skips app save when Cmd/Ctrl+S is disabled for a clean document', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        deps.canSave.value = false;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('does not intercept Cmd/Ctrl+S in Electron where the menu accelerator owns save', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('prevents default for Ctrl+B when active with PDF', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault,
        }));
        expect(preventDefault).toHaveBeenCalledOnce();
    });

    it('skips shortcuts when editing text', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        // Simulate an input element target using a minimal HTMLElement-like object
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: fakeInput,
            preventDefault,
        }));
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it('opens search for Cmd/Ctrl+F even when focus starts in an editable field', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'f',
            code: 'KeyF',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: fakeInput,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps.openSearch).toHaveBeenCalledOnce();
    });

    it('handles Escape to close context menus', async () => {
        const deps = createDeps();
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'Escape',
            code: 'Escape',
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: vi.fn(),
        }));
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });

    it('deletes the selected shape on Delete without modifiers', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'Delete',
            code: 'Delete',
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).toHaveBeenCalledOnce();
    });

    it('does not intercept Delete or Backspace inside editable fields', async () => {
        const deps = createDeps();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const key of [
            'Delete',
            'Backspace',
        ]) {
            const preventDefault = vi.fn();
            capturedOnEventFired?.(cast<KeyboardEvent>({
                type: 'keydown',
                key,
                code: key,
                metaKey: false,
                ctrlKey: false,
                altKey: false,
                target: fakeInput,
                preventDefault,
            }));

            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).not.toHaveBeenCalled();
    });

    it('ignores modified Alt shortcuts', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            ctrlKey: false,
            altKey: true,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handleToggleSidebar).not.toHaveBeenCalled();
    });

    it('does not route Cmd/Ctrl+P when renderer accelerators are delegated', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handlePrint).not.toHaveBeenCalled();
    });

    it('handles fit-width and fit-height shortcuts on the web where no menu accelerator exists', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventFitWidth = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '1',
            code: 'Digit1',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventFitWidth,
        }));
        expect(preventFitWidth).toHaveBeenCalledOnce();
        expect(deps.handleFitMode).toHaveBeenNthCalledWith(1, 'width');

        const preventFitHeight = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '2',
            code: 'Digit2',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventFitHeight,
        }));
        expect(preventFitHeight).toHaveBeenCalledOnce();
        expect(deps.handleFitMode).toHaveBeenNthCalledWith(2, 'height');
    });

    it('leaves fit shortcuts to the Electron menu accelerators', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const key of [
            '1',
            '2',
        ]) {
            const preventDefault = vi.fn();
            capturedOnEventFired?.(cast<KeyboardEvent>({
                type: 'keydown',
                key,
                code: `Digit${key}`,
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                target: null,
                preventDefault,
            }));
            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(deps.handleFitMode).not.toHaveBeenCalled();
    });

    function pressPagingKey(key: string, overrides: Record<string, unknown> = {}) {
        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
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

    it('pages the document with PageUp/PageDown/Home/End through the workspace navigation chain', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        expect(pressPagingKey('PageDown')).toHaveBeenCalledOnce();
        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(1, 4, { navigationSource: 'toolbar' });

        expect(pressPagingKey('PageUp')).toHaveBeenCalledOnce();
        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(2, 2, { navigationSource: 'toolbar' });

        expect(pressPagingKey('Home')).toHaveBeenCalledOnce();
        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(3, 1, { navigationSource: 'toolbar' });

        expect(pressPagingKey('End')).toHaveBeenCalledOnce();
        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(4, 10, { navigationSource: 'toolbar' });
    });

    it('steps a whole spread in facing view modes', async () => {
        const deps = createDeps();
        deps.viewMode.value = 'facing';
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        pressPagingKey('PageDown');
        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(1, 5, { navigationSource: 'toolbar' });

        pressPagingKey('PageUp');
        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(2, 1, { navigationSource: 'toolbar' });
    });

    it('keeps the last spread stable when paging past the end', async () => {
        const deps = createDeps();
        deps.navigationPage.value = 10;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        expect(pressPagingKey('PageDown')).toHaveBeenCalledOnce();
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it('composes rapid paging from the pending navigation page, not the settled page', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        pressPagingKey('PageDown');
        deps.navigationPage.value = 4;
        pressPagingKey('PageDown');

        expect(deps.handleGoToPage).toHaveBeenNthCalledWith(2, 5, { navigationSource: 'toolbar' });
    });

    it('leaves paging keys to the browser while the page count is unknown', async () => {
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');

        for (const totalPages of [
            0,
            Number.NaN,
        ]) {
            const deps = createDeps();
            deps.totalPages.value = totalPages;
            usePageShortcuts(deps);

            expect(pressPagingKey('PageDown')).not.toHaveBeenCalled();
            expect(deps.handleGoToPage).not.toHaveBeenCalled();
        }
    });

    it('keeps paging keys inert while typing in editable controls', async () => {
        const deps = createDeps();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        const fakeNoteEditor = {
            isContentEditable: true,
            closest: () => null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        Object.setPrototypeOf(fakeNoteEditor, HTMLElement.prototype);
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const target of [
            fakeInput,
            fakeNoteEditor,
        ]) {
            for (const key of [
                'PageDown',
                'PageUp',
                'Home',
                'End',
            ]) {
                expect(pressPagingKey(key, { target })).not.toHaveBeenCalled();
            }
        }
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it('ignores modified paging keys so tab and selection accelerators keep working', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const overrides of [
            { ctrlKey: true },
            { metaKey: true },
            { shiftKey: true },
            { altKey: true },
        ]) {
            expect(pressPagingKey('PageDown', overrides)).not.toHaveBeenCalled();
        }
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it('does not intercept arrow keys used for thumbnail selection', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const key of [
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
            ' ',
        ]) {
            expect(pressPagingKey(key)).not.toHaveBeenCalled();
            expect(pressPagingKey(key, { shiftKey: true })).not.toHaveBeenCalled();
        }
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it('leaves paging keys to the browser after the document source is cleared', async () => {
        const deps = createDeps();
        // A closed document leaves the last document's page count behind, so the
        // count alone must never authorise paging.
        deps.pdfSrc.value = null;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const key of [
            'PageDown',
            'PageUp',
            'Home',
            'End',
        ]) {
            expect(pressPagingKey(key)).not.toHaveBeenCalled();
        }
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it('honors the host non-interactive state while a document source remains', async () => {
        // Keep pdfSrc populated on purpose. The host flag is authoritative and
        // may turn false during a transition before the source is cleared.
        const deps = {
            ...createDeps(),
            hasInteractiveDocument: ref(false),
        };
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        expect(pressPagingKey('PageDown')).not.toHaveBeenCalled();
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it('closes visible shortcut menus on outside pointerdown', async () => {
        const deps = createDeps();
        deps.shapePropertiesPopoverVisible.value = true;
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const target = { closest: vi.fn(() => null) };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(target, HTMLElement.prototype);

        capturedPointerDown?.(cast<PointerEvent>({target}));

        expect(deps.closeShapeProperties).toHaveBeenCalledOnce();
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });
});
