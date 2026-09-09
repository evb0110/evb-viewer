import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPageShortcutDeps as createDeps,
    pressPagingKey,
    resetPageShortcutsTest,
    restorePageShortcutsTest,
} from '@tests/helpers/usePageShortcutsTestFixtures';

describe('usePageShortcuts', () => {
    beforeEach(resetPageShortcutsTest);
    afterEach(restorePageShortcutsTest);

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

    it.each([
        0,
        Number.NaN,
    ])('leaves paging keys to the browser while the page count is %s', async (totalPages) => {
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        const deps = createDeps();
        deps.totalPages.value = totalPages;
        usePageShortcuts(deps);

        expect(pressPagingKey('PageDown')).not.toHaveBeenCalled();
        expect(deps.handleGoToPage).not.toHaveBeenCalled();
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

});
