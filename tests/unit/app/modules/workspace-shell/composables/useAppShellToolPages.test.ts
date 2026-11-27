import {describe, expect, it, vi} from 'vitest';
import {ref} from 'vue';
import {useAppShellToolPages} from '@app/modules/workspace-shell/composables/useAppShellToolPages';
import {requireDocumentRef} from '@contracts/documentRef';

describe('useAppShellToolPages', () => {
    it('reuses an empty tab for settings and activates it', () => {
        const activeToolPage = ref<'combine' | null>('combine');
        const setTabStartSection = vi.fn();
        const activateTabById = vi.fn();
        const actions = useAppShellToolPages({
            activePaneId: ref('pane-1'),
            activeToolPage,
            activateTabById,
            createTab: vi.fn(),
            findEmptyTab: () => ({
                id: 'tab-empty',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }),
            openResultInAppropriateTab: vi.fn(),
            setTabStartSection,
        });

        actions.openSettingsPage();

        expect(activeToolPage.value).toBeNull();
        expect(setTabStartSection).toHaveBeenCalledWith('tab-empty', 'settings');
        expect(activateTabById).toHaveBeenCalledWith('tab-empty');
    });

    it('closes the combine tool before opening its output', async () => {
        const activeToolPage = ref<'combine' | null>('combine');
        const openResultInAppropriateTab = vi.fn(async () => {});
        const actions = useAppShellToolPages({
            activePaneId: ref(null),
            activeToolPage,
            activateTabById: vi.fn(),
            createTab: vi.fn(),
            findEmptyTab: () => null,
            openResultInAppropriateTab,
            setTabStartSection: vi.fn(),
        });
        const result = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/tmp/combined.pdf'),
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
        } as const;

        await actions.handleCombineOpenResult(result);

        expect(activeToolPage.value).toBeNull();
        expect(openResultInAppropriateTab).toHaveBeenCalledWith(result);
    });

    it('keeps the combine tool open when workspace routing reports a failed open', async () => {
        const activeToolPage = ref<'combine' | null>('combine');
        const actions = useAppShellToolPages({
            activePaneId: ref(null),
            activeToolPage,
            activateTabById: vi.fn(),
            createTab: vi.fn(),
            findEmptyTab: () => null,
            openResultInAppropriateTab: vi.fn(async () => false),
            setTabStartSection: vi.fn(),
        });

        await expect(
            actions.handleCombineOpenResult({
                kind: 'pdf',
                originalPath: requireDocumentRef('/tmp/combined.pdf'),
                workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            }),
        ).resolves.toBe(false);
        expect(activeToolPage.value).toBe('combine');
    });
});
