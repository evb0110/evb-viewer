// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
} from 'vue';
import type { App } from 'vue';
import {
    requirePaneId,
    type IEditorPaneState,
} from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import type { ITabLifecycleState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

// What the pane owns is which tabs it presents. Its children render an
// identifiable placeholder, so the assertions read the pane's markup instead
// of a document workspace or a tab strip.
vi.mock('@app/modules/workspace-shell/components/DocumentWorkspaceTab.vue', () => ({default: defineComponent({
    name: 'DocumentWorkspaceTabStub',
    props: {tabId: {
        type: String,
        required: true,
    }},
    setup(props) {
        return () => h('div', {
            'class': 'workspace-host-stub',
            'data-host-tab-id': props.tabId,
        });
    },
})}));

vi.mock('@app/modules/workspace-shell/components/layout/TabBar.vue', () => ({default: defineComponent({
    name: 'TabBarStub',
    setup() {
        return () => h('div', {class: 'tab-bar-stub'});
    },
})}));

let mountedApp: App | null = null;
let mountedHost: HTMLElement | null = null;

afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    mountedHost?.remove();
    mountedHost = null;
});

function createTab(tabId: string): ITab {
    return {id: tabId};
}

function createReleasedHostLifecycle(tabId: string): ITabLifecycleState {
    return {
        tabId,
        temperature: 'cold',
        viewerResidency: 'hibernated',
        isReclaimCandidate: true,
        shouldMountHost: false,
    };
}

async function mountEditorPane({
    activeTabId,
    tabIds,
    tabLifecycleById = {},
    zenActiveTabId = null,
    zenMode = false,
}: {
    activeTabId: string | null;
    tabIds: string[];
    tabLifecycleById?: Record<string, ITabLifecycleState>;
    zenActiveTabId?: string | null;
    zenMode?: boolean;
}) {
    const { default: EditorPaneView } = await import(
        '@app/modules/workspace-shell/components/EditorPaneView.vue'
    );
    const pane: IEditorPaneState = {
        paneId: requirePaneId('pane-1'),
        tabIds: tabIds.map(tabId => requireTabId(tabId)),
        activeTabId: activeTabId === null ? null : requireTabId(activeTabId),
    };
    const documentSessionsByTabId = Object.fromEntries(tabIds.map(tabId => [
        tabId,
        createWorkspaceDocumentController({
            tabId,
            assignment: {
                fileName: `${tabId}.pdf`,
                originalPath: requireDocumentRef(`/documents/${tabId}.pdf`),
                isDirty: false,
                isDjvu: false,
            },
        }),
    ]));
    const app = createApp(defineComponent({setup() {
        return () => h(EditorPaneView, {
            pane,
            paneCount: 1,
            tabs: tabIds.map(createTab),
            activePaneId: 'pane-1',
            isTabTransitionBusy: false,
            tabContextAvailability: null,
            startSectionByTabId: {},
            tabLifecycleById,
            documentSessionsByTabId,
            zenMode,
            zenActiveTabId,
            isFullscreen: false,
            fullscreenSupported: false,
            isWorkspaceLayoutResizing: false,
        });
    }}));
    const host = document.createElement('div');
    document.body.append(host);
    app.mount(host);
    mountedApp = app;
    mountedHost = host;
    return {host};
}

function readHost(root: HTMLElement, tabId: string) {
    const element = root.querySelector<HTMLElement>(`[data-host-tab-id="${tabId}"]`);
    if (!element) {
        throw new Error(`The pane never mounted a host for ${tabId}.`);
    }
    return element;
}

describe('editor pane presentation', () => {
    it('presents only the active tab, including while another tab opens a document', async () => {
        const {host} = await mountEditorPane({
            activeTabId: 'tab-new',
            tabIds: [
                'tab-old',
                'tab-new',
                'tab-idle',
            ],
        });

        // A new tab shows its own opening; the tab it replaced is not kept on
        // screen over it.
        expect(readHost(host, 'tab-new').style.display).not.toBe('none');
        expect(readHost(host, 'tab-old').style.display).toBe('none');
        expect(readHost(host, 'tab-idle').style.display).toBe('none');
    });

    it('drops released hosts and zen-hidden tabs from the pane', async () => {
        const {host} = await mountEditorPane({
            activeTabId: 'tab-new',
            tabIds: [
                'tab-released',
                'tab-new',
            ],
            tabLifecycleById: {'tab-released': createReleasedHostLifecycle('tab-released')},
        });

        expect(host.querySelector('[data-host-tab-id="tab-released"]')).toBeNull();
        expect(host.querySelector('.tab-bar-stub')).not.toBeNull();

        mountedApp?.unmount();
        mountedApp = null;
        mountedHost?.remove();
        mountedHost = null;

        const zen = await mountEditorPane({
            activeTabId: 'tab-new',
            tabIds: [
                'tab-old',
                'tab-new',
            ],
            zenActiveTabId: 'tab-new',
            zenMode: true,
        });

        expect(zen.host.querySelector('[data-host-tab-id="tab-old"]')).toBeNull();
        expect(zen.host.querySelector('[data-host-tab-id="tab-new"]')).not.toBeNull();
        // Zen mode presents the document alone, without the tab strip.
        expect(zen.host.querySelector('.tab-bar-stub')).toBeNull();
    });
});
