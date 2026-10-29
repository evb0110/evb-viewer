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

vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfEmptyState', () => ({PdfEmptyState: defineComponent({setup: () => () => h('div')})}));

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
            if (!state.has(key)) state.set(key, ref(initial()));
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
            session.commitDocument({
                fileName: 'a.pdf',
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
