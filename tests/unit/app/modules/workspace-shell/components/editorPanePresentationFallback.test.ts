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

// What the pane owns is which tabs it presents and how it marks them. Its
// children render an identifiable placeholder, with the sidebar element the
// pane's own stylesheet reaches into, so the assertions read the pane's markup
// instead of a document workspace or a tab strip.
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
        }, [h('aside', {class: 'sidebar-wrapper'})]);
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
    presentationFallbackTabId = null,
    tabIds,
    tabLifecycleById = {},
    zenActiveTabId = null,
    zenMode = false,
}: {
    activeTabId: string | null;
    presentationFallbackTabId?: string | null;
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
            presentationFallbackTabId,
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

describe('editor pane presentation fallback', () => {
    it('marks the outgoing host so the pane stylesheet can reach its sidebar', async () => {
        const {host} = await mountEditorPane({
            activeTabId: 'tab-new',
            presentationFallbackTabId: 'tab-old',
            tabIds: [
                'tab-old',
                'tab-new',
            ],
        });

        // The fallback keeps painting, which is what stops the open from
        // flashing; only its sidebar has to stop being presented.
        const fallbackHost = readHost(host, 'tab-old');
        expect(fallbackHost.style.display).not.toBe('none');
        expect(readHost(host, 'tab-new').style.display).not.toBe('none');
        // The rule that hides the outgoing sidebar is written against the
        // fallback host as a direct child of the pane content, so the class has
        // to land exactly there and the sidebar has to be inside it.
        expect(host.querySelector('.editor-pane-content > .is-presentation-fallback')).toBe(fallbackHost);
        expect(fallbackHost.querySelector('.sidebar-wrapper')).not.toBeNull();
        expect(readHost(host, 'tab-new').classList.contains('is-presentation-fallback')).toBe(false);
    });

    it('never marks the active tab as its own fallback', async () => {
        const {host} = await mountEditorPane({
            activeTabId: 'tab-old',
            presentationFallbackTabId: 'tab-old',
            tabIds: ['tab-old'],
        });

        // Once the fallback tab is the tab being presented, its sidebar
        // describes the document on screen and has to stay visible.
        expect(host.querySelector('.is-presentation-fallback')).toBeNull();
        expect(readHost(host, 'tab-old').style.display).not.toBe('none');
    });

    it('keeps every other mounted host out of the presented surface', async () => {
        const {host} = await mountEditorPane({
            activeTabId: 'tab-new',
            presentationFallbackTabId: 'tab-old',
            tabIds: [
                'tab-old',
                'tab-new',
                'tab-idle',
            ],
        });

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
