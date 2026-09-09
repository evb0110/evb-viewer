import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    afterEach,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {createKeyboardEventFixture} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import {createPointerDownEvent} from '@tests/unit/app/modules/workspace-shell/composables/createPointerDownEvent';
import {
    createPageShortcutDeps as createDeps,
    getCapturedKeyDown,
    getCapturedOnEventFired,
    getCapturedPointerDown,
    getPageShortcutsMocks,
    resetPageShortcutsTest,
    restorePageShortcutsTest,
    pressPagingKey,
} from '@tests/helpers/usePageShortcutsTestFixtures';

const mocks = getPageShortcutsMocks();

describe('usePageShortcuts', () => {
    beforeEach(resetPageShortcutsTest);
    afterEach(restorePageShortcutsTest);

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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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

        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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

        getCapturedKeyDown()?.(createKeyboardEventFixture({
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

        getCapturedKeyDown()?.(createKeyboardEventFixture({
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

        getCapturedKeyDown()?.(createKeyboardEventFixture({
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
        getCapturedKeyDown()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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

        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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

        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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

    it('preserves an input method Escape before workspace cancellation', async () => {
        const deps = createDeps();
        deps.annotationTool.value = 'text';
        deps.annotationContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);
        const event = createKeyboardEventFixture({key: 'Escape'});
        Object.defineProperty(event, 'isComposing', {value: true});
        getCapturedOnEventFired()?.(event);
        expect(deps.closeAnnotationContextMenu).not.toHaveBeenCalled();
        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalled();
    });

    it.each([
        false,
        true,
    ])('leaves editable Escape to the focused text editor with menus open %s', async menusOpen => {
        const deps = createDeps();
        deps.annotationTool.value = 'text';
        deps.annotationContextMenuVisible.value = menusOpen;
        deps.pageContextMenuVisible.value = menusOpen;
        const handleAnnotationEscape = vi.fn(() => true);
        const viewer = {
            ...deps.pdfViewerRef.value,
            handleAnnotationEscape,
        };
        const {usePageShortcuts} = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts({
            ...deps,
            pdfViewerRef: ref(viewer),
        });
        const fakeInput = {
            isContentEditable: true,
            closest: () => null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        onTestFinished(() => { vi.unstubAllGlobals(); });
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        const preventDefault = vi.fn();
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
            key: 'Escape',
            target: fakeInput,
            preventDefault,
        }));
        expect(handleAnnotationEscape).not.toHaveBeenCalled();
        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledTimes(Number(menusOpen));
        expect(deps.closePageContextMenu).toHaveBeenCalledTimes(Number(menusOpen));
    });

    it('deactivates the annotation tool when Escape has no editor interaction to finish', async () => {
        const deps = createDeps();
        deps.annotationTool.value = 'draw';
        const {usePageShortcuts} = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);
        getCapturedOnEventFired()?.(createKeyboardEventFixture({key: 'Escape'}));
        expect(deps.handleAnnotationToolChange).toHaveBeenCalledWith('none');
    });

    it('finishes the current editor interaction before cancelling its tool on Escape', async () => {
        const deps = createDeps();
        deps.annotationTool.value = 'text';
        const handleAnnotationEscape = vi.fn(() => true);
        const {usePageShortcuts} = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts({
            ...deps,
            pdfViewerRef: ref({
                ...deps.pdfViewerRef.value,
                handleAnnotationEscape,
            }),
        });
        getCapturedOnEventFired()?.(createKeyboardEventFixture({key: 'Escape'}));
        expect(handleAnnotationEscape).toHaveBeenCalledOnce();
        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalled();
    });

    it('handles Escape to close context menus', async () => {
        const deps = createDeps();
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
            getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
            getCapturedOnEventFired()?.(createKeyboardEventFixture({
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
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const target = { closest: vi.fn(() => null) };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(target, HTMLElement.prototype);

        getCapturedPointerDown()?.(createPointerDownEvent(target));

        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });
});
