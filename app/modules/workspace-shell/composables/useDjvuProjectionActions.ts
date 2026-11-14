import type { Ref } from 'vue';
import { until } from '@vueuse/core';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';

const PROJECTION_PLACEMENT_TIMEOUT_MS = 30000;

interface IDjvuProjectionActionOptions {
    isDjvuMode: Ref<boolean>;
    /** The open document; an edit waiting for the projection belongs to it. */
    documentRef: Readonly<Ref<unknown>>;
    /** The view's surface, which reports when the projected PDF is placed. */
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot'>;
    ensureProjection: (reason: 'edit' | 'ocr' | 'save-as-pdf') => Promise<boolean>;
    saveAs: () => Promise<boolean>;
    exportDocx: (selectedLanguages?: string[]) => Promise<void>;
    isExportingDocx: Ref<boolean>;
    cancelExportDocx: () => void;
    handleDropdownOpen: (
        dropdown: 'zoom' | 'page' | 'ocr',
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
        const document = options.documentRef.value;
        const generation = options.openSurface.snapshot.value.generation;
        if (!await options.ensureProjection(reason)) {
            return false;
        }
        // The projection opens as a restore of the reader's place; the edit
        // waits for the view to report that PDF placed. Another document may
        // have replaced this one meanwhile.
        const settled = await until(() => {
            const snapshot = options.openSurface.snapshot.value;
            return options.documentRef.value !== document
                || snapshot.phase === 'failed'
                || snapshot.generation !== generation && snapshot.phase === 'ready';
        }).toBe(true, {timeout: PROJECTION_PLACEMENT_TIMEOUT_MS});
        return settled
            && options.documentRef.value === document
            && options.openSurface.snapshot.value.phase === 'ready';
    }

    async function runEdit<T>(action: () => T | Promise<T>) {
        if (await ensureProjection('edit')) {
            return action();
        }
        return undefined;
    }

    async function ensureDropdownProjection(
        dropdown: 'zoom' | 'page' | 'ocr',
        isOpen: boolean,
    ) {
        if (dropdown !== 'ocr' || !isOpen || await ensureProjection('ocr')) {
            options.handleDropdownOpen(dropdown, isOpen);
        }
    }

    return {
        ensureEditProjection: () => ensureProjection('edit'),
        handleSaveAs: options.saveAs,
        async handleExportDocx(selectedLanguages?: string[]) {
            if (options.isExportingDocx.value) {
                options.cancelExportDocx();
                return;
            }
            if (await ensureProjection('ocr')) await options.exportDocx(selectedLanguages);
        },
        handleDropdownOpen(
            dropdown: 'zoom' | 'page' | 'ocr',
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
