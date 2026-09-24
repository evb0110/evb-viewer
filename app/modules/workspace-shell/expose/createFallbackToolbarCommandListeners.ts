import type {Ref} from 'vue';
import {guardAsync} from '@app/utils/asyncGuard';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {IWorkspaceExpose} from '@app/types/workspaceExpose';
import {
    invokeWorkspaceExposeCommand,
    workspaceExposeToolbarCommandDescriptors,
    WorkspaceExposeCommandUnavailableError,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';

export function createFallbackToolbarCommandListeners(activeWorkspace: Readonly<Ref<IWorkspaceExpose | null>>) {
    function run(commandName: TWorkspaceExposeMethod, args: readonly unknown[] = []) {
        const workspace = activeWorkspace.value;
        if (!workspace) {
            BrowserLogger.error('shell', 'Fallback workspace command unavailable', {error: new WorkspaceExposeCommandUnavailableError(commandName)}, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            return;
        }

        const result: unknown = invokeWorkspaceExposeCommand(workspace, commandName, args);
        if (result instanceof Promise) {
            guardAsync(result, {
                category: 'user-visible-operation',
                scope: 'shell',
                message: `Fallback workspace command failed: ${commandName}`,
            });
        }
    }

    return {
        listeners: Object.fromEntries(workspaceExposeToolbarCommandDescriptors.map(descriptor => [
            descriptor.toolbar.eventName,
            (...args: unknown[]) => run(descriptor.name, args),
        ])),
        run,
    };
}
