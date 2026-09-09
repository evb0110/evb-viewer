// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

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
    reactive,
    ref,
} from 'vue';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import {createDefaultWorkspaceToolbarSnapshot} from '@app/types/workspaceExpose';
import {DESKTOP_EDITOR_READER_COMMAND_SURFACE} from '@app/utils/readerCommandSurface';

const toolbarRenders: Array<Record<string, unknown>> = [];
const pageRenders: Array<Record<string, unknown>> = [];
const zoomRenders: Array<Record<string, unknown>> = [];

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/composables/useAssistantPanel', () => ({useAssistantPanel: () => ({
    isAvailable: ref(false),
    isEnabled: ref(false),
    isOpen: ref(false),
    toggle: vi.fn(),
})}));
vi.mock('@app/modules/scan-cleanup/public/runtime', () => ({
    formatScanCleanupProgress: () => ({text: 'scanCleanup.running'}),
    isScanCleanupRunning: ref(false),
    ScanCleanupScissorsIcon: defineComponent({setup: () => () => h('span')}),
    scanCleanupRun: {jobState: null},
}));

vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfToolbar', () => ({PdfToolbar: defineComponent({
    inheritAttrs: false,
    emits: ['toggle-sidebar'],
    setup(_props, {
        attrs,
        emit,
        slots,
    }) {
        return () => {
            toolbarRenders.push({...attrs});
            return h('section', [
                h('button', {
                    type: 'button',
                    'data-toggle-sidebar': '',
                    onClick: () => emit('toggle-sidebar'),
                }),
                slots['page-dropdown']?.({compactLevel: 0}),
                slots['zoom-dropdown']?.({compactLevel: 0}),
            ]);
        };
    },
})}));

vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfPageDropdown', () => ({PdfPageDropdown: defineComponent({
    inheritAttrs: false,
    props: [
        'modelValue',
        'totalPages',
        'navigationPage',
        'disabled',
    ],
    emits: ['go-to-page'],
    setup(props, {emit}) {
        return () => {
            pageRenders.push({...props});
            return h('button', {
                type: 'button',
                'data-go-to-page': '',
                onClick: () => emit('go-to-page', 4),
            });
        };
    },
})}));

vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfZoomDropdown', () => ({PdfZoomDropdown: defineComponent({
    inheritAttrs: false,
    props: [
        'disabled',
        'canUseViewModes',
    ],
    setup(props) {
        return () => {
            zoomRenders.push({...props});
            return h('div', {'data-zoom-dropdown': ''});
        };
    },
})}));

function inertComponent() {
    return {default: defineComponent({setup: () => () => h('div')})};
}
vi.mock('@app/components/toolbar/ToolbarAppMenu.vue', inertComponent);
vi.mock('@app/components/toolbar/ToolbarOverflowMenu.vue', inertComponent);

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    toolbarRenders.length = 0;
    pageRenders.length = 0;
    zoomRenders.length = 0;
});

function latestRender(renders: Array<Record<string, unknown>>, label: string) {
    const render = renders.at(-1);
    if (!render) {
        throw new Error(`${label} did not render.`);
    }
    return render;
}

async function mountToolbarPresenter() {
    const host = document.createElement('div');
    document.body.append(host);
    const onGoToPage = vi.fn();
    const onToggleSidebar = vi.fn();
    const snapshot = reactive(createDefaultWorkspaceToolbarSnapshot());
    Object.assign(snapshot, {
        hasPdf: true,
        initialVisualReady: true,
        openingPreviewReady: true,
        isOpeningDocument: true,
        currentPage: 1,
        totalPages: 882,
    });
    const presentation = reactive({
        documentBusy: true,
        viewingReady: true,
        controlsDisabled: false,
    });
    const app = createApp(defineComponent({setup: () => () => h(WorkspacePdfToolbarView, {
        snapshot,
        hasPdf: true,
        canToggleSidebar: true,
        canUseOcr: false,
        isDesktopRuntime: true,
        surface: DESKTOP_EDITOR_READER_COMMAND_SURFACE,
        isFullscreen: false,
        fullscreenSupported: true,
        pageDropdownTotalPages: 882,
        ocrPopupOpen: false,
        zoomDropdownOpen: false,
        pageDropdownOpen: false,
        overflowMenuOpen: false,
        appMenuOpen: false,
        ...presentation,
        onGoToPage,
        onToggleSidebar,
    })}));
    app.component('AppTooltip', defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())}));
    app.component('UButton', defineComponent({setup: () => () => h('button')}));
    app.mount(host);
    await nextTick();

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        onGoToPage,
        onToggleSidebar,
        presentation,
        snapshot,
        unmount,
    };
}

describe('WorkspacePdfToolbarView opening preview', () => {
    it('presents committed native pagination while navigation and view controls remain available', async () => {
        const presenter = await mountToolbarPresenter();

        expect(latestRender(toolbarRenders, 'PDF toolbar')).toMatchObject({
            'has-pdf': true,
            'document-busy': true,
            'viewing-ready': true,
            'can-toggle-sidebar': true,
        });
        expect(latestRender(pageRenders, 'page dropdown')).toMatchObject({
            modelValue: 1,
            totalPages: 882,
            navigationPage: 1,
            disabled: false,
        });
        expect(latestRender(zoomRenders, 'zoom dropdown')).toMatchObject({
            disabled: false,
            canUseViewModes: false,
        });

        presenter.host.querySelector<HTMLButtonElement>('[data-toggle-sidebar]')?.click();
        expect(presenter.onToggleSidebar).toHaveBeenCalledOnce();

        presenter.host.querySelector<HTMLButtonElement>('[data-go-to-page]')?.click();
        await nextTick();
        expect(presenter.onGoToPage).toHaveBeenCalledWith(4);
        expect(latestRender(pageRenders, 'page dropdown')).toMatchObject({
            modelValue: 1,
            navigationPage: 4,
        });

        presenter.snapshot.currentPage = 4;
        presenter.snapshot.openingPreviewReady = false;
        presenter.snapshot.isOpeningDocument = false;
        presenter.snapshot.viewerCapabilities.viewMode = true;
        presenter.presentation.documentBusy = false;
        await nextTick();

        expect(latestRender(pageRenders, 'page dropdown')).toMatchObject({
            modelValue: 4,
            navigationPage: 4,
        });
        expect(latestRender(zoomRenders, 'zoom dropdown')).toMatchObject({
            disabled: false,
            canUseViewModes: true,
        });
    });
});
