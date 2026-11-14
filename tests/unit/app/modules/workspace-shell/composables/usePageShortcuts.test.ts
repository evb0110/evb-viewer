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
    getCapturedPaste,
    getCapturedPointerDown,
    getPageShortcutsMocks,
    resetPageShortcutsTest,
    restorePageShortcutsTest,
    pressShortcut,
} from '@tests/helpers/usePageShortcutsTestFixtures';

const mocks = getPageShortcutsMocks();

async function mountShortcuts(deps: Parameters<(typeof import('@app/modules/workspace-shell/composables/usePageShortcuts'))['usePageShortcuts']>[0]) {
    const {usePageShortcuts} = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
    usePageShortcuts(deps);
}

describe('usePageShortcuts', () => {
    beforeEach(resetPageShortcutsTest);
    afterEach(restorePageShortcutsTest);

    it.each<{
        name: string;
        key: string;
        code?: string;
        command: 'handleZoomIn' | 'handleZoomOut' | 'handleActualSize' | 'handlePrint' | 'handleSave' | 'handleFitMode';
        renderer?: boolean;
        hasPdf?: boolean;
        enabled?: boolean;
        capture?: boolean;
        argument?: 'width' | 'height';
    }>([
        {name: 'web zoom in', key: '=', code: 'Equal', command: 'handleZoomIn'},
        {name: 'web print', key: 'p', command: 'handlePrint'},
        {name: 'printable non-PDF document', key: 'p', command: 'handlePrint', hasPdf: false},
        {name: 'disabled print', key: 'p', command: 'handlePrint', enabled: false},
        {name: 'web save', key: 's', command: 'handleSave'},
        {name: 'Electron save ownership', key: 's', command: 'handleSave', renderer: false},
        {name: 'delegated print ownership', key: 'p', command: 'handlePrint', renderer: false},
        {name: 'web fit width', key: '1', code: 'Digit1', command: 'handleFitMode', argument: 'width'},
        {name: 'Electron fit width ownership', key: '1', code: 'Digit1', command: 'handleFitMode', renderer: false},
        {name: 'capture save before editable control', key: 's', command: 'handleSave', capture: true},
        {name: 'capture print before editable control', key: 'p', command: 'handlePrint', capture: true},
        {name: 'Electron capture save ownership', key: 's', command: 'handleSave', renderer: false, capture: true},
        {name: 'disabled capture save', key: 's', command: 'handleSave', enabled: false, capture: true},
        {name: 'web zoom out', key: '-', code: 'Minus', command: 'handleZoomOut'},
        {name: 'web actual size', key: '0', code: 'Digit0', command: 'handleActualSize'},
        {name: 'web fit height', key: '2', code: 'Digit2', command: 'handleFitMode', argument: 'height'},
        {name: 'Electron fit height ownership', key: '2', code: 'Digit2', command: 'handleFitMode', renderer: false},
    ])('routes $name', async ({key, code = `Key${key.toUpperCase()}`, command, renderer = true, hasPdf = true, enabled = true, capture = false, argument}) => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(renderer);
        const deps = createDeps();
        if (!hasPdf) deps.pdfSrc.value = null;
        deps.canPrint.value = enabled;
        deps.canSave.value = enabled;
        await mountShortcuts(deps);
        const stopPropagation = vi.fn();
        const preventDefault = pressShortcut(key, {
            code, metaKey: true, stopPropagation,
            target: capture ? {nodeName: 'TEXTAREA'} : null,
        }, capture ? getCapturedKeyDown() : getCapturedOnEventFired());

        expect(preventDefault.mock.calls.length > 0).toBe(renderer);
        if (capture) expect(stopPropagation).toHaveBeenCalledTimes(Number(renderer));
        expect(deps[command]).toHaveBeenCalledTimes(Number(renderer && enabled));
        if (argument) expect(deps[command]).toHaveBeenCalledWith(argument);
    });

    it('routes web Cmd/Ctrl+S to save while focus is inside editable annotation UI', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        await mountShortcuts(deps);

        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        const preventDefault = pressShortcut('s', {code: 'KeyS', metaKey: true, target: fakeInput});

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('prevents default for Ctrl+B when active with PDF', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);

        const preventDefault = pressShortcut('b', {code: 'KeyB', metaKey: true});
        expect(preventDefault).toHaveBeenCalledOnce();
    });

    it('skips shortcuts when editing text', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);

        // Simulate an input element target using a minimal HTMLElement-like object
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        const preventDefault = pressShortcut('b', {code: 'KeyB', metaKey: true, target: fakeInput});
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it('opens search for Cmd/Ctrl+F even when focus starts in an editable field', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);

        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        const preventDefault = pressShortcut('f', {code: 'KeyF', metaKey: true, target: fakeInput});

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps.openSearch).toHaveBeenCalledOnce();
    });

    it('preserves an input method Escape before workspace cancellation', async () => {
        const deps = createDeps();
        deps.annotationTool.value = 'text';
        deps.annotationContextMenuVisible.value = true;
        await mountShortcuts(deps);
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
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        onTestFinished(() => { vi.unstubAllGlobals(); });
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        const preventDefault = pressShortcut('Escape', {target: fakeInput});
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
        pressShortcut('Escape');
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
        pressShortcut('Escape');
        expect(handleAnnotationEscape).toHaveBeenCalledOnce();
        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalled();
    });

    it('handles Escape to close context menus', async () => {
        const deps = createDeps();
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        await mountShortcuts(deps);

        pressShortcut('Escape');
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });

    it('deletes the selected shape on Delete without modifiers', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);

        const preventDefault = pressShortcut('Delete', {code: 'Delete'});

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).toHaveBeenCalledOnce();
    });

    it('does not intercept Delete or Backspace inside editable fields', async () => {
        const deps = createDeps();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        await mountShortcuts(deps);

        for (const key of [
            'Delete',
            'Backspace',
        ]) {
            const preventDefault = pressShortcut(key, {code: key, target: fakeInput});

            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).not.toHaveBeenCalled();
    });

    it('leaves Delete, paging, Cmd+S and Cmd+B pressed inside a dialog to the dialog', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        vi.stubGlobal('Element', class ElementStub {});
        const dialogButton = {closest: (selector: string) => selector.includes('dialog') ? dialogButton : null};
        Object.setPrototypeOf(dialogButton, Element.prototype);
        await mountShortcuts(deps);

        for (const key of [
            'Delete',
            'PageDown',
        ]) {
            const preventDefault = pressShortcut(key, {code: key, target: dialogButton});
            expect(preventDefault, key).not.toHaveBeenCalled();
        }
        const save = createKeyboardEventFixture({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: dialogButton,
        });
        getCapturedKeyDown()?.(save);
        pressShortcut('b', {code: 'KeyB', metaKey: true, target: dialogButton});
        const keys = mocks.useMagicKeys.mock.results[0]?.value;
        keys.meta.value = true;
        keys.b.value = true;
        // The one `whenever` gate is Cmd/Ctrl+B, the sidebar toggle.
        expect(mocks.whenever.mock.calls[0]?.[0]()).toBeFalsy();
        expect(deps.handleSave).not.toHaveBeenCalled();
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('ignores modified Alt shortcuts', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);

        const preventDefault = pressShortcut('b', {code: 'KeyB', metaKey: true, altKey: true});

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handleToggleSidebar).not.toHaveBeenCalled();
    });

    it('honors the host non-interactive state while a document source remains', async () => {
        // Keep pdfSrc populated on purpose. The host flag is authoritative and
        // may turn false during a transition before the source is cleared.
        const deps = {
            ...createDeps(),
            hasInteractiveDocument: ref(false),
        };
        await mountShortcuts(deps);

        expect(pressShortcut('PageDown')).not.toHaveBeenCalled();
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
    });

    it.each([
        [
            'i',
            'handleInsertImageFromFile',
        ],
        [
            'v',
            'handlePasteImageFromClipboard',
        ],
    ] as const)('routes web Shift+Cmd/Ctrl+%s to the Edit menu image command', async (key, command) => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        await mountShortcuts(deps);

        const preventDefault = pressShortcut(key.toUpperCase(), {ctrlKey: true, shiftKey: true});

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps[command]).toHaveBeenCalledOnce();
    });

    it('leaves Shift+Cmd/Ctrl+V to the Electron menu and to editable fields', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);
        const pastePlainText = {
            key: 'V',
            ctrlKey: true,
            shiftKey: true,
        } as const;

        getCapturedOnEventFired()?.(createKeyboardEventFixture(pastePlainText));
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        pressShortcut('V', {...pastePlainText, target: fakeInput});

        expect(deps.handlePasteImageFromClipboard).not.toHaveBeenCalled();
    });

    it('places the image a paste event carries, except into an editable field', async () => {
        const deps = createDeps();
        await mountShortcuts(deps);
        const image = new File([Uint8Array.of(1)], 'image.png', {type: 'image/png'});
        const paste = (target: unknown, files: File[]) => {
            const event = new Event('paste', {cancelable: true});
            Object.defineProperties(event, {
                target: {value: target},
                clipboardData: {value: {files}},
            });
            getCapturedPaste()?.(event as ClipboardEvent);
            return event.defaultPrevented;
        };

        expect(paste(null, [new File(['text'], 'note.txt', {type: 'text/plain'})])).toBe(false);
        expect(deps.handlePasteImageFile).not.toHaveBeenCalled();
        const fakeEditor = {
            isContentEditable: true,
            closest: () => fakeEditor,
        };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeEditor, HTMLElement.prototype);
        expect(paste(fakeEditor, [image])).toBe(false);
        expect(deps.handlePasteImageFile).not.toHaveBeenCalled();

        expect(paste(null, [image])).toBe(true);
        expect(deps.handlePasteImageFile).toHaveBeenCalledWith(image);
    });

    it('closes visible shortcut menus on outside pointerdown', async () => {
        const deps = createDeps();
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        await mountShortcuts(deps);

        const target = { closest: vi.fn(() => null) };
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(target, HTMLElement.prototype);

        getCapturedPointerDown()?.(createPointerDownEvent(target));

        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });
});
