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
    nextTick,
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
    props: {panePresentation: {
        type: String,
        default: 'single',
    }},
    setup(props) {
        return () => h('div', {
            class: 'tab-bar-stub',
            'data-pane-presentation': props.panePresentation,
        });
    },
})}));

const targets = vi.hoisted(() => ({desktop: true, listTargetWindows: vi.fn()}));
vi.mock('@app/utils/platformWindowTabs', () => ({
    canUseNativeWindowTabTransfers: () => targets.desktop,
    getWindowTabsCapability: () => targets,
}));

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
    activePaneId = 'pane-1',
    activeTabId,
    inPlace = false,
    paneCount = 1,
    tabIds,
    tabLifecycleById = {},
    zenActiveTabId = null,
    zenMode = false,
}: {
    activePaneId?: string | null;
    activeTabId: string | null;
    inPlace?: boolean;
    paneCount?: number;
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
            paneCount,
            inPlace,
            tabs: tabIds.map(createTab),
            activePaneId,
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

    it.each([
        {
            activePaneId: 'pane-1',
            expected: 'single',
            inPlace: true,
            paneCount: 1,
        },
        {
            activePaneId: 'pane-1',
            expected: 'split-active',
            inPlace: false,
            paneCount: 2,
        },
        {
            activePaneId: 'pane-2',
            expected: 'split-inactive',
            inPlace: false,
            paneCount: 2,
        },
    ])('derives $expected tab bar presentation and in-place state', async ({
        activePaneId,
        expected,
        inPlace,
        paneCount,
    }) => {
        const {host} = await mountEditorPane({
            activePaneId,
            activeTabId: 'tab-1',
            inPlace,
            paneCount,
            tabIds: ['tab-1'],
        });

        const pane = host.querySelector<HTMLElement>('.editor-pane');
        const tabBar = host.querySelector<HTMLElement>('.tab-bar-stub');
        expect(pane?.classList.contains('is-in-place')).toBe(inPlace);
        expect(tabBar?.dataset.panePresentation).toBe(expected);
    });

    it('applies split pane classes on TabBar root from panePresentation', async () => {
        const {default: TabBar} = await vi.importActual<typeof import('@app/modules/workspace-shell/components/layout/TabBar.vue')>('@app/modules/workspace-shell/components/layout/TabBar.vue');
        const slot = defineComponent({inheritAttrs: false, setup: (_props, {slots}) => () => slots.default?.()});
        vi.stubGlobal('useToast', () => ({add: vi.fn()}));

        try {
            for (const [
                panePresentation,
                isSplit,
                isSplitActive,
            ] of [
                [
                    'single',
                    false,
                    false,
                ],
                [
                    'split-inactive',
                    true,
                    false,
                ],
                [
                    'split-active',
                    true,
                    true,
                ],
            ] as const) {
                const app = createApp({render: () => h(TabBar, {
                    tabs: [{
                        id: 'tab-1',
                        fileName: 'a.pdf',
                        originalPath: null,
                        isDirty: false,
                        isDjvu: false,
                    }],
                    activeTabId: 'tab-1',
                    panePresentation,
                })});
                app.component('AppTooltip', slot);
                app.component('UDropdownMenu', slot);
                app.component('Icon', slot);
                const host = document.createElement('div');
                document.body.append(host);
                app.mount(host);
                try {
                    const root = host.querySelector<HTMLElement>('.tab-bar');
                    expect(root?.dataset.panePresentation).toBe(panePresentation);
                    expect(root?.classList.contains('is-split-pane')).toBe(isSplit);
                    expect(root?.classList.contains('is-split-active-pane')).toBe(isSplitActive);
                } finally {
                    app.unmount();
                    host.remove();
                }
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('#1608 desktop window transfer target feedback', () => {
    it('explains a failed desktop destination query when the tab menu opens', async () => {
        const {default: TabBar} = await vi.importActual<typeof import('@app/modules/workspace-shell/components/layout/TabBar.vue')>('@app/modules/workspace-shell/components/layout/TabBar.vue');
        const messages: string[] = [];
        vi.stubGlobal('useToast', () => ({add: (notice: {title: string; description?: string}) => {
            messages.push([notice.title, notice.description].filter(Boolean).join(' '));
        }}));
        targets.listTargetWindows.mockRejectedValue(new Error('Window registry unavailable'));
        const app = createApp({render: () => h(TabBar, {tabs: [{id: 'tab-1', fileName: 'a.pdf', originalPath: null, isDirty: false, isDjvu: false}], activeTabId: 'tab-1'})});
        const slot = defineComponent({inheritAttrs: false, setup: (_props, {slots}) => () => slots.default?.()});
        app.component('AppTooltip', slot); app.component('UDropdownMenu', slot); app.component('Icon', slot);
        const host = document.createElement('div'); document.body.append(host); app.mount(host);
        try {
            host.querySelector('[role="tab"]')!.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
            await nextTick(); await Promise.resolve();
            expect(messages.join(' ')).toMatch(/window|destination|transfer/i);
        } finally {app.unmount(); host.remove(); vi.unstubAllGlobals();}
    });
});
