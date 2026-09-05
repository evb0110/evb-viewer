import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { useDjvuProjectionActions } from '@app/modules/workspace-shell/composables/useDjvuProjectionActions';

describe('useDjvuProjectionActions', () => {
    it('preserves the PDF image placement result through the projection wrapper', async () => {
        const pasteImageFromClipboard = vi.fn(async () => true);
        const actions = useDjvuProjectionActions({
            isDjvuMode: ref(false),
            currentPage: ref(31),
            documentViewerRef: ref(null),
            ensureProjection: vi.fn(async () => true),
            saveAs: vi.fn(async () => true),
            exportDocx: vi.fn(async () => undefined),
            isExportingDocx: ref(false),
            cancelExportDocx: vi.fn(),
            handleDropdownOpen: vi.fn(),
            insertImageFromFile: vi.fn(),
            pasteImageFromClipboard,
            createQuickNote: vi.fn(),
        });

        await expect(actions.handlePasteImageFromClipboard()).resolves.toBe(true);
        expect(pasteImageFromClipboard).toHaveBeenCalledOnce();
    });

    it('cancels an active DOCX export before waiting for DjVu projection', async () => {
        const ensureProjection = vi.fn(async () => true);
        const exportDocx = vi.fn(async () => undefined);
        const cancelExportDocx = vi.fn();
        const actions = useDjvuProjectionActions({
            isDjvuMode: ref(true),
            currentPage: ref(1),
            documentViewerRef: ref(null),
            ensureProjection,
            saveAs: vi.fn(async () => true),
            exportDocx,
            isExportingDocx: ref(true),
            cancelExportDocx,
            handleDropdownOpen: vi.fn(),
            insertImageFromFile: vi.fn(),
            pasteImageFromClipboard: vi.fn(),
            createQuickNote: vi.fn(),
        });

        await actions.handleExportDocx();

        expect(cancelExportDocx).toHaveBeenCalledOnce();
        expect(ensureProjection).not.toHaveBeenCalled();
        expect(exportDocx).not.toHaveBeenCalled();
    });
});
