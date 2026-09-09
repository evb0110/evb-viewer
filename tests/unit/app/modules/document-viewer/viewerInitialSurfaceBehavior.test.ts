// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
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
} from 'vue';
import NativePdfPageContent from '@app/modules/native-pdf-viewer/components/NativePdfPageContent.vue';
import PdfInitialSurfacePlaceholder from '@app/modules/pdf-viewer/components/PdfInitialSurfacePlaceholder.vue';
import { WORKSPACE_VIEWER_ADAPTERS } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IDocumentPreviewPageState } from '@app/utils/document-viewer/pagePreviewSource';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const SkeletonStub = defineComponent({setup: () => () => h('span', {'data-ui-skeleton': ''})});
const ButtonStub = defineComponent({
    inheritAttrs: true,
    props: {label: {
        type: String,
        default: '',
    }},
    setup: props => () => h('button', props.label),
});
const activeUnmounts = new Set<() => void>();

function mount(component: Parameters<typeof createApp>[0]) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(component);
    app.component('USkeleton', SkeletonStub);
    app.component('UIcon', SkeletonStub);
    app.component('UButton', ButtonStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        unmount,
    };
}

describe('viewer initial-surface behavior', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        for (const unmount of activeUnmounts) unmount();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('routes every document renderer through the shared chassis adapter', () => {
        expect(new Set(WORKSPACE_VIEWER_ADAPTERS.map(adapter => adapter.component))).toHaveLength(1);
    });

    it('renders a measured PDF opening shell with the real page skeleton', () => {
        const harness = mount(defineComponent({setup: () => () => h(PdfInitialSurfacePlaceholder, {pageStyle: {
            width: '612px',
            height: '792px',
        }})}));

        const placeholder = harness.host.querySelector('[data-evb-initial-visual-placeholder="true"]');
        const shell = harness.host.querySelector<HTMLElement>('.pdf-initial-surface-placeholder__page-shell');
        expect(placeholder).not.toBeNull();
        expect(shell?.classList.contains('pdf-initial-surface-placeholder__page-shell--measured')).toBe(true);
        expect(shell?.style.width).toBe('612px');
        expect(shell?.style.height).toBe('792px');
        expect(shell?.querySelector('.document-page-skeleton')).not.toBeNull();
        expect(shell?.querySelector<HTMLElement>('.document-page-skeleton')?.style.padding).toBe('56px');
        expect(shell?.querySelectorAll('[data-ui-skeleton]').length).toBeGreaterThan(0);

        harness.unmount();
    });

    it('keeps a native preview hidden behind its skeleton until paint commits', async () => {
        const pageState = ref<IDocumentPreviewPageState>({
            failedRenderPx: 0,
            objectUrl: 'blob:page-4',
            renderedPx: 1200,
            status: 'loaded',
            token: 1,
        });
        const visualCommitted = ref(false);
        const events: Array<{
            objectUrl: string;
            pageNumber: number;
        }> = [];
        let retries = 0;
        const harness = mount(defineComponent({setup: () => () => h(NativePdfPageContent, {
            pageNumber: 4,
            pageState: pageState.value,
            showSkeleton: true,
            visualCommitted: visualCommitted.value,
            onRetry: () => { retries += 1; },
            onVisualReady: (payload: {
                objectUrl: string;
                pageNumber: number
            }) => events.push(payload),
        })}));

        const image = harness.host.querySelector<HTMLImageElement>('.native-pdf-page-image');
        expect(image).not.toBeNull();
        expect(harness.host.querySelector('.document-page-skeleton')).not.toBeNull();
        expect(harness.host.querySelector('.native-pdf-page-content')?.classList.contains(
            'document-page-visual--committed',
        )).toBe(false);

        vi.useFakeTimers();
        image?.dispatchEvent(new Event('load'));
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual([]);

        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual([]);

        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual([{
            objectUrl: 'blob:page-4',
            pageNumber: 4,
        }]);

        visualCommitted.value = true;
        await nextTick();
        expect(harness.host.querySelector('.document-page-skeleton')).toBeNull();
        expect(harness.host.querySelector('.native-pdf-page-content')?.classList.contains(
            'document-page-visual--committed',
        )).toBe(true);
        expect(harness.host.querySelector('.native-pdf-page-number')?.textContent).toContain('4');

        pageState.value = {
            ...pageState.value,
            objectUrl: null,
            status: 'error',
        };
        visualCommitted.value = false;
        await nextTick();
        harness.host.querySelector<HTMLButtonElement>('button')?.click();
        expect(harness.host.querySelector('.native-pdf-page-placeholder')).not.toBeNull();
        expect(retries).toBe(1);

        harness.unmount();
    });
});
