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
    provide,
    shallowRef,
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import {
    createDocumentOpenSurfaceSession,
    documentOpenSurfaceSessionKey,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import DocumentViewerChassis from '@app/modules/workspace-shell/components/DocumentViewerChassis.vue';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';

vi.mock('@app/modules/workspace-shell/viewers/workspaceViewerFeatureChunkLoaders', async () => {
    const vue = await import('vue');
    const {documentViewerChassisAuthorityKey} = await import(
        '@app/utils/document-viewer/chassis/documentViewerChassisAuthority'
    );
    const createFeaturePackStub = (kind: string) => vue.defineComponent({
        inheritAttrs: false,
        props: {
            bindDelayMs: {
                type: Number,
                required: true,
            },
            testSource: {
                type: Object,
                required: true,
            },
        },
        setup(props) {
            const authority = vue.inject(documentViewerChassisAuthorityKey);
            vue.onMounted(() => {
                setTimeout(() => authority?.bindSource(props.testSource as IDocumentPageSource), props.bindDelayMs);
            });
            return () => vue.h('div', {
                'data-feature-pack-kind': kind,
                'data-feature-pack-stub': '',
            });
        },
    });
    return {workspaceViewerFeatureChunkLoaders: {
        pdfjs: async () => ({PdfViewer: createFeaturePackStub('pdfjs')}),
        'native-pdf': async () => ({NativePdfViewer: createFeaturePackStub('native-pdf')}),
        'page-source': async () => ({default: createFeaturePackStub('page-source')}),
    }};
});

vi.mock('@app/components/document-viewer/DocumentThumbnailList.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        inheritAttrs: false,
        props: {source: {
            type: Object,
            default: null,
        }},
        setup(props, {attrs}) {
            return () => vue.h('div', {
                ...attrs,
                'data-thumbnail-source-rows': (props.source as IDocumentPageSource | null)?.pageCount ?? 0,
            });
        },
    })};
});

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const source: IDocumentPageSource = {
    kind: 'pdf',
    documentRef: requireDocumentRef('/book.pdf'),
    pageCount: 3,
    getPageMetrics: vi.fn(async () => ({
        widthPoints: 500,
        heightPoints: 700,
        rotation: 0 as const,
    })),
    renderPage: vi.fn(async () => ({
        widthPx: 100,
        heightPx: 140,
        bytes: 56_000,
        surface: 'data:image/png;base64,',
        release: vi.fn(),
    })),
    dispose: vi.fn(),
};

const mountedApps = new Set<() => void>();

function mountWorkspaceChain(
    openInitially: boolean,
    rendererKind: 'pdfjs' | 'native-pdf' | 'page-source' = 'pdfjs',
) {
    const host = document.createElement('div');
    document.body.append(host);
    const cleanupOpen = shallowRef(openInitially);
    const pageSource = shallowRef<IDocumentPageSource | null>(null);
    const Root = defineComponent({setup() {
        provide(documentOpenSurfaceSessionKey, createDocumentOpenSurfaceSession());
        return () => h('div', [
            h(DocumentViewerChassis, {
                sourceKind: 'pdf',
                rendererKind,
                bindDelayMs: 25,
                testSource: source,
                'onUpdate:pageSource': (value: IDocumentPageSource | null) => {
                    pageSource.value = value;
                },
            }),
            h('span', {'data-workspace-source-ready': pageSource.value ? 'true' : 'false'}),
            cleanupOpen.value
                ? h(ScanCleanupThumbnailRail, {
                    source: pageSource.value,
                    sourcePending: pageSource.value === null,
                    totalPages: 3,
                    selectionLeader: 1,
                    selectedPages: new Set([1]),
                    overrides: {},
                    classifications: new Map(),
                    confidences: new Map(),
                    textAxes: new Map(),
                    documentOutputMode: 'auto',
                    preserveOriginalQuality: false,
                    disabled: false,
                })
                : null,
        ]);
    }});
    const app = createApp(Root);
    const passthrough = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});
    app.component('AppTooltip', passthrough);
    app.component('UBadge', passthrough);
    app.component('UButton', passthrough);
    app.component('UIcon', passthrough);
    app.component('UPopover', passthrough);
    app.component('USelect', passthrough);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        mountedApps.delete(unmount);
    };
    mountedApps.add(unmount);
    return {
        cleanupOpen,
        host,
        pageSource,
    };
}

afterEach(() => {
    for (const unmount of mountedApps) unmount();
    document.body.innerHTML = '';
});

describe('DocumentWorkspace page-source integration', () => {
    it.each([
        [
            'pdfjs',
            'pdfjs',
        ],
        [
            'native-pdf',
            'native-pdf',
        ],
        [
            'page-source',
            'page-source',
        ],
    ] as const)('mounts the driver-selected %s feature pack', async (rendererKind, expectedKind) => {
        const harness = mountWorkspaceChain(false, rendererKind);

        await vi.waitFor(() => {
            expect(harness.host.querySelector(`[data-feature-pack-kind="${expectedKind}"]`)).not.toBeNull();
        });
    });

    it('delivers a chassis-bound source when cleanup opens before the delayed bind', async () => {
        const harness = mountWorkspaceChain(true);
        expect(harness.host.querySelector('.scan-thumbnail-source-state')).not.toBeNull();

        await vi.waitFor(() => {
            expect(harness.host.querySelector('[data-thumbnail-source-rows="3"]')).not.toBeNull();
        });
        expect(harness.pageSource.value).toBe(source);
    });

    it('retains a chassis-bound source emitted before cleanup opens', async () => {
        const harness = mountWorkspaceChain(false);
        await vi.waitFor(() => {
            expect(harness.host.querySelector('[data-workspace-source-ready="true"]')).not.toBeNull();
        });

        harness.cleanupOpen.value = true;
        await nextTick();

        expect(harness.host.querySelector('[data-thumbnail-source-rows="3"]')).not.toBeNull();
        expect(harness.pageSource.value).toBe(source);
    });
});
