import {
    describe,
    expect,
    it,
} from 'vitest';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

describe('workspace document controller views', () => {
    it('retires a mounted view on removal: its workspace is gone and later mounts are refused', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.addView('tab-2');
        const view = controller.getView('tab-2')!;
        const workspace = createWorkspaceExposeFixture();
        controller.attachWorkspace('tab-2', workspace);
        expect(await view.whenMounted()).toBe(workspace);

        expect(controller.removeView('tab-2')).toBe(1);

        expect(controller.getView('tab-2')).toBeNull();
        expect(view.mountedWorkspace.value).toBeNull();
        expect(await view.whenMounted()).toBeNull();
        controller.attachWorkspace('tab-2', workspace);
        expect(view.mountedWorkspace.value).toBeNull();
    });

    it('answers a pending mount waiter of a removed, never-mounted view with null', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const view = controller.getView('tab-1')!;
        const pending = view.whenMounted();

        expect(controller.removeView('tab-1')).toBe(0);

        await expect(pending).resolves.toBeNull();
        await expect(view.whenMounted()).resolves.toBeNull();
    });
});
