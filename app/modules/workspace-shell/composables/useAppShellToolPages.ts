import type {Ref} from 'vue';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import type {TStartSection} from '@app/types/startSection';
import type {ITab} from '@app/types/tabs';

interface IAppShellToolPageOptions {
    activePaneId: Ref<string | null>;
    activeToolPage: Ref<'combine' | null>;
    activateTabById: (tabId: string) => void;
    createTab: (options: {paneId: string | null; activate: boolean}) => ITab;
    findEmptyTab: () => ITab | null;
    openResultInAppropriateTab: (result: TOpenFileResult) => Promise<unknown>;
    setTabStartSection: (tabId: string, section: TStartSection) => void;
}

export const useAppShellToolPages = (options: IAppShellToolPageOptions) => {
    function closeToolPage() {
        options.activeToolPage.value = null;
    }

    function openSettingsPage() {
        closeToolPage();
        const tab =
            options.findEmptyTab() ??
            options.createTab({
                paneId: options.activePaneId.value,
                activate: true,
            });
        options.setTabStartSection(tab.id, 'settings');
        options.activateTabById(tab.id);
    }

    function openCombinePage() {
        options.activeToolPage.value = 'combine';
    }

    async function handleCombineOpenResult(result: TOpenFileResult) {
        try {
            const opened = await options.openResultInAppropriateTab(result);
            if (opened === false) {
                return false;
            }
            closeToolPage();
            return true;
        } catch {
            return false;
        }
    }

    return {
        closeToolPage,
        handleCombineOpenResult,
        openCombinePage,
        openSettingsPage,
    };
};
