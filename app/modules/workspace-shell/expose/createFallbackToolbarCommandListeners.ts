import type {Ref} from 'vue';
import {guardAsync} from '@app/utils/asyncGuard';
import type {IWorkspaceExpose} from '@app/types/workspaceExpose';

// Toolbar events the shell toolbar forwards to the active workspace while its
// own toolbar is not mounted yet.
const TOOLBAR_COMMANDS = {
    'save': 'handleSave',
    'repair-save': 'handleRepairSave',
    'optimize-pdf-for-interaction': 'handleOptimizePdfForInteraction',
    'save-as': 'handleSaveAs',
    'print': 'handlePrint',
    'print-current-page': 'handlePrintCurrentPage',
    'undo': 'handleUndo',
    'redo': 'handleRedo',
    'export-docx': 'handleExportDocx',
    'export-images': 'handleExportImages',
    'export-multi-page-tiff': 'handleExportMultiPageTiff',
    'fit-width': 'handleFitWidth',
    'fit-height': 'handleFitHeight',
    'go-to-page': 'handleGoToPage',
    'toggle-sidebar': 'handleToggleSidebar',
    'toggle-continuous-scroll': 'handleToggleContinuousScroll',
    'enable-drag': 'handleEnableDragMode',
    'disable-drag': 'handleDisableDragMode',
    'capture-region': 'handleCaptureRegion',
    'crop': 'handleCrop',
    'quick-note': 'handleQuickNote',
    'insert-image-from-file': 'handleInsertImageFromFile',
    'paste-image-from-clipboard': 'handlePasteImageFromClipboard',
    'delete-pages': 'handleDeletePages',
    'extract-pages': 'handleExtractPages',
    'rotate-cw': 'handleRotateCw',
    'rotate-ccw': 'handleRotateCcw',
    'insert-pages': 'handleInsertPages',
    'convert-to-pdf': 'handleConvertToPdf',
    'ocr-complete': 'handleOcrComplete',
} as const satisfies Record<string, keyof IWorkspaceExpose>;

export function createFallbackToolbarCommandListeners(activeWorkspace: Readonly<Ref<IWorkspaceExpose | null>>) {
    function run(commandName: string, args: readonly unknown[] = []) {
        const command = (activeWorkspace.value as Record<string, ((...commandArgs: unknown[]) => unknown) | undefined> | null)?.[commandName];
        const result = command?.(...args);
        if (result instanceof Promise) {
            guardAsync(result, {
                category: 'user-visible-operation',
                scope: 'shell',
                message: `Fallback workspace command failed: ${commandName}`,
            });
        }
    }

    return {
        listeners: Object.fromEntries(Object.entries(TOOLBAR_COMMANDS).map(([
            eventName,
            commandName,
        ]) => [
            eventName,
            (...args: unknown[]) => run(commandName, args),
        ])),
        run,
    };
}
