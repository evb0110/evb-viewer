import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import type { ITab } from '@app/types/tabs';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import { readToastDescription } from '@tests/helpers/toastDescription';

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

const toastAdd = vi.fn();
vi.stubGlobal('useToast', () => ({add: toastAdd}));

afterEach(() => {
    toastAdd.mockClear();
});

const receipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
    occurredAt: requireEpochMs(1_790_000_000_000),
    severity: 'error',
} as FailureReceipt;

function createSessions() {
    const tabs = ref<ITab[]>([{id: 'tab-1'}]);
    const sessions = useWorkspaceDocumentSessions({
        activeTabId: ref('tab-1'),
        tabs,
    });
    return {
        session: sessions.getSession('tab-1')!,
        tabs,
    };
}

function openThatFails(failure: FailureReceipt | null) {
    const {
        session,
        tabs,
    } = createSessions();
    const opened = session.runOpen({
        kind: 'open',
        target: {
            fileName: 'gone.pdf',
            originalPath: requireDocumentRef('/docs/gone.pdf'),
        },
    }, async () => {
        session.markFailed({
            message: 'The file was moved or deleted.',
            failure,
        });
        return false;
    });
    return {
        opened,
        tabs,
    };
}

describe('a tab whose open fails', () => {
    it('tells why once, naming the file, even when the tab is then removed', async () => {
        const {
            opened,
            tabs,
        } = openThatFails(receipt);
        await expect(opened).resolves.toBe(false);
        tabs.value = [];

        expect(toastAdd).toHaveBeenCalledOnce();
        const toast = toastAdd.mock.calls[0]?.[0];
        expect(toast).toMatchObject({
            id: receipt.eventId,
            color: 'error',
            title: 'errors.file.open',
        });
        expect(readToastDescription(toast.description)).toBe('gone.pdf: The file was moved or deleted.\nError ID: 01234567');
    });

    it('tells an expected outcome without a receipt as a warning with nothing to copy', async () => {
        const {opened} = openThatFails(null);
        await opened;

        expect(toastAdd).toHaveBeenCalledOnce();
        expect(toastAdd.mock.calls[0]?.[0]).toEqual({
            color: 'warning',
            icon: 'i-ph-warning',
            title: 'errors.file.open',
            description: 'gone.pdf: The file was moved or deleted.',
        });
    });
});
