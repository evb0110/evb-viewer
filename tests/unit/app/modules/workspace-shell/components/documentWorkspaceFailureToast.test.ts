import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
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
    ref,
    shallowRef,
    type App,
} from 'vue';
import type {IFailureToastTarget} from '@app/composables/useFailureToast';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';

const renderFailure = ref(false);

// Keep the real tab boundary, controller and toast presenter. Only the PDF
// workspace is replaced with a renderer that can hit the reported page error.
vi.mock('@app/modules/workspace-shell/components/DocumentWorkspace.vue', () => {
    const Page = defineComponent({
        props: {page: {
            type: Number,
            required: true,
        }},
        setup: props => () => h('p', String(requirePageNumber(props.page, 1))),
    });
    return {
        __esModule: true,
        default: defineComponent({
            name: 'FailingDocumentWorkspace',
            // Two descendants observe the same invalid page during one render
            // update, before the boundary can replace the failed subtree.
            setup: () => () => h('section', Array.from({length: 2}, (_, index) => h(Page, {
                key: index,
                page: renderFailure.value ? 2 : 1,
            }))),
        }),
    };
});

const recentOpen = vi.hoisted(() => ({followed: null as Promise<boolean> | null}));
vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfEmptyState', () => ({PdfEmptyState: defineComponent({
    emits: ['reveal-recent', 'open-recent'],
    setup: (_props, {emit}) => () => h('div', [
        h('button', {onClick: () => emit('reveal-recent', {
            originalPath: '/docs/recent.pdf', fileName: 'recent.pdf',
        })}, 'Reveal recent'),
        h('button', {onClick: () => emit('open-recent', {
            originalPath: '/docs/recent.djvu', fileName: 'recent.djvu',
        }, false, (opening: Promise<boolean>) => { recentOpen.followed = opening; })}, 'Open recent'),
    ]),
})}));

vi.mock('@app/composables/useRecentFiles', () => ({useRecentFiles: () => ({
    recentFiles: ref([]),
    isResolved: ref(true),
    error: ref(null),
    loadRecentFiles: async () => undefined,
})}));

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    app?.unmount();
    host?.remove();
    app = null;
    host = null;
    renderFailure.value = false;
    vi.unstubAllGlobals();
});

describe('document workspace failure presentation (C4)', () => {
    it('presents exactly one error toast when one workspace render fails in multiple descendants', async () => {
        type TToast = Parameters<IFailureToastTarget['add']>[0];
        const toasts = shallowRef(new Map<string, TToast>());
        // Nuxt UI identifies toasts by id: another add with the same id updates
        // the existing toast. Count rendered presentations, not add calls.
        vi.stubGlobal('useToast', (): IFailureToastTarget => ({add: toast => {
            toasts.value = new Map(toasts.value).set(toast.id ?? String(toasts.value.size), toast);
        }}));
        const state = new Map<string, unknown>();
        vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
            if (!state.has(key)) {state.set(key, ref(initial()));}
            return state.get(key);
        });
        const loggedErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const {useWorkspaceDocumentSessions} = await import('@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions');
        const {default: DocumentWorkspaceTab} = await import('@app/modules/workspace-shell/components/DocumentWorkspaceTab.vue');
        host = document.createElement('div');
        document.body.append(host);
        app = createApp(defineComponent({setup() {
            const sessions = useWorkspaceDocumentSessions({
                activeTabId: ref('tab-a'),
                tabs: ref([{id: 'tab-a'}]),
            });
            const session = sessions.getSession('tab-a')!;
            session.commitFile({
                originalPath: requireDocumentRef('/docs/a.pdf'),
                isDjvu: false,
                revisionInfo: null,
            });
            return () => h('main', [
                h(DocumentWorkspaceTab, {
                    tabId: 'tab-a',
                    documentSession: session,
                    isActive: true,
                    isRenderActive: true,
                    isTabTransitionBusy: false,
                    startSection: 'recent',
                    isFullscreen: false,
                    fullscreenSupported: true,
                    isWorkspaceLayoutResizing: false,
                }),
                ...[...toasts.value.values()].map(toast => h('div', {
                    role: 'status',
                    'data-toast-color': toast.color,
                }, [
                    h('strong', toast.title),
                    typeof toast.description === 'function' ? toast.description() : toast.description,
                    ...toast.actions?.map(action => h('button', {onClick: action.onClick}, action.label)) ?? [],
                ])),
            ]);
        }}));
        app.component('ClientOnly', defineComponent({setup: (_props, {slots}) => () => slots.default?.()}));
        app.component('UButton', defineComponent({
            props: ['label'],
            setup: props => () => h('button', props.label),
        }));
        app.mount(host);
        await vi.waitFor(() => expect(host?.querySelector('.workspace-host p')?.textContent).toBe('1'));

        renderFailure.value = true;
        await nextTick();
        await nextTick();

        expect(host.querySelector('[role="alert"]')?.textContent).toContain('Page number must be a positive safe integer within the document');
        expect(loggedErrors).toHaveBeenCalled();
        const errorToasts = host.querySelectorAll('[role="status"][data-toast-color="error"]');
        expect(errorToasts).toHaveLength(1);
        expect(errorToasts[0]?.textContent).toContain('errors.runtime.copy');
    });
});

it.each(['reject', 'false'])('#1608 explains a failed Recent show-in-folder action (%s)', async outcome => {
    const messages: string[] = [];
    vi.stubGlobal('useToast', () => ({add: (notice: {title: string; description?: string}) => {
        messages.push([notice.title, notice.description].filter(Boolean).join(' '));
    }}));
    vi.stubGlobal('window', Object.assign(window, {electronAPI: createElectronPlatformApiFixture({documentWindow: {
        showItemInFolder: async () => {
            if (outcome === 'false') {return false;}
            throw new Error('Recent file manager unavailable');
        },
    }})}));
    const state = new Map<string, unknown>();
    vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
        if (!state.has(key)) {state.set(key, ref(initial()));}
        return state.get(key);
    });
    const {createWorkspaceDocumentController} = await import('@app/modules/workspace-shell/document-sessions/workspaceDocumentController');
    const {default: DocumentWorkspaceTab} = await import('@app/modules/workspace-shell/components/DocumentWorkspaceTab.vue');
    host = document.createElement('div'); document.body.append(host);
    const recentSession = createWorkspaceDocumentController({tabId: 'recent'});
    app = createApp({render: () => h(DocumentWorkspaceTab, {
        tabId: 'recent', documentSession: recentSession,
        isActive: true, isRenderActive: true, isTabTransitionBusy: false,
        startSection: 'recent', isFullscreen: false, fullscreenSupported: true, isWorkspaceLayoutResizing: false,
    })});
    app.component('ClientOnly', defineComponent({setup: (_props, {slots}) => () => slots.default?.()}));
    app.mount(host);
    try {
        host.querySelector('button')!.click();
        await vi.waitFor(() => expect(messages.join(' ')).toMatch(/folder|reveal/i));
    } finally {Reflect.deleteProperty(window, 'electronAPI');}
});

it('ends a cold Start Recent open whose claim another open took while its workspace mounts', async () => {
    vi.stubGlobal('useToast', () => ({add: () => undefined}));
    vi.stubGlobal('window', Object.assign(window, {electronAPI: createElectronPlatformApiFixture()}));
    const state = new Map<string, unknown>();
    vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
        if (!state.has(key)) {state.set(key, ref(initial()));}
        return state.get(key);
    });
    const {createWorkspaceDocumentController} = await import('@app/modules/workspace-shell/document-sessions/workspaceDocumentController');
    const {default: DocumentWorkspaceTab} = await import('@app/modules/workspace-shell/components/DocumentWorkspaceTab.vue');
    host = document.createElement('div'); document.body.append(host);
    const session = createWorkspaceDocumentController({tabId: 'cold'});
    app = createApp({render: () => h(DocumentWorkspaceTab, {
        tabId: 'cold', documentSession: session,
        isActive: true, isRenderActive: true, isTabTransitionBusy: false,
        startSection: 'recent', isFullscreen: false, fullscreenSupported: true, isWorkspaceLayoutResizing: false,
    })});
    app.component('ClientOnly', defineComponent({setup: (_props, {slots}) => () => slots.default?.()}));
    app.component('UProgress', defineComponent({setup: () => () => h('div')}));
    app.mount(host);
    try {
        recentOpen.followed = null;
        [...host.querySelectorAll('button')].find(button => button.textContent === 'Open recent')!.click();
        await nextTick();
        expect(session.snapshot.value.activeTransaction?.target?.originalPath).toBe('/docs/recent.djvu');
        // The workspace never mounts; another open takes the tab meanwhile.
        session.claimOpen({kind: 'open', target: null});
        await expect(recentOpen.followed).resolves.toBe(false);
    } finally {Reflect.deleteProperty(window, 'electronAPI');}
});
