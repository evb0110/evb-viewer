import type { Ref } from 'vue';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';

interface IDjvuProjectionActionOptions {
    isDjvuMode: Ref<boolean>;
    currentPage: Ref<number>;
    documentViewerRef: Ref<IDocumentViewerExpose | null>;
    ensureProjection: (reason: 'edit' | 'ocr' | 'save-as-pdf') => Promise<boolean>;
    saveAs: () => Promise<boolean>;
    exportDocx: (selectedLanguages?: string[]) => Promise<void>;
    isExportingDocx: Ref<boolean>;
    cancelExportDocx: () => void;
    handleDropdownOpen: (
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) => void;
    insertImageFromFile: () => unknown;
    pasteImageFromClipboard: () => unknown;
    createQuickNote: () => unknown;
}

export const useDjvuProjectionActions = (options: IDjvuProjectionActionOptions) => {
    async function ensureProjection(reason: 'edit' | 'ocr' | 'save-as-pdf') {
        if (!options.isDjvuMode.value) {
            return true;
        }
        const viewer = options.documentViewerRef.value;
        const fallbackPage = viewer?.getCurrentPage?.() ?? options.currentPage.value;
        if (!await options.ensureProjection(reason)) {
            return false;
        }
        await nextTick();
        await options.documentViewerRef.value?.waitForViewerLoadSettled?.();
        options.documentViewerRef.value?.scrollToPage(fallbackPage);
        return true;
    }

    async function runEdit<T>(action: () => T | Promise<T>) {
        if (await ensureProjection('edit')) {
            return action();
        }
        return undefined;
    }

    async function ensureDropdownProjection(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) {
        if (dropdown !== 'ocr' || !isOpen || await ensureProjection('ocr')) {
            options.handleDropdownOpen(dropdown, isOpen);
        }
    }

    return {
        ensureEditProjection: () => ensureProjection('edit'),
        handleSaveAs: () => options.isDjvuMode.value
            ? ensureProjection('save-as-pdf')
            : options.saveAs(),
        async handleExportDocx(selectedLanguages?: string[]) {
            if (options.isExportingDocx.value) {
                options.cancelExportDocx();
                return;
            }
            if (await ensureProjection('ocr')) await options.exportDocx(selectedLanguages);
        },
        handleDropdownOpen(
            dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
            isOpen: boolean,
        ) {
            void ensureDropdownProjection(dropdown, isOpen);
        },
        runEdit,
        handleInsertImageFromFile: async () => {
            await runEdit(options.insertImageFromFile);
        },
        // The workspace expose contract is currently void-typed, but the
        // Electron command runner must receive the placement result.
        handlePasteImageFromClipboard: () => (
            runEdit(options.pasteImageFromClipboard) as Promise<void>
        ),
        handleQuickNoteAction: () => runEdit(options.createQuickNote),
    };
};
