import type {Ref} from 'vue';
import {guardAsync} from '@app/utils/asyncGuard';
import type {IWorkspaceExpose} from '@app/types/workspaceExpose';

// Toolbar events the shell's fallback toolbar and the window's More tools
// forward to the active workspace, which they resolve when the event arrives.
const TOOLBAR_COMMANDS = {
    'save': 'handleSave',
    'save-as': 'handleSaveAs',
    'print': 'handlePrint',
    'print-current-page': 'handlePrintCurrentPage',
    'undo': 'handleUndo',
    'redo': 'handleRedo',
    'export-docx': 'handleExportDocx',
    'fit-width': 'handleFitWidth',
    'fit-height': 'handleFitHeight',
    'toggle-sidebar': 'handleToggleSidebar',
    'toggle-continuous-scroll': 'handleToggleContinuousScroll',
    'enable-drag': 'handleEnableDragMode',
    'disable-drag': 'handleDisableDragMode',
    'capture-region': 'handleCaptureRegion',
    'crop': 'handleCrop',
    'quick-note': 'handleQuickNote',
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
