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
    ref,
} from 'vue';
import NativePdfPageContent from '@app/modules/native-pdf-viewer/components/NativePdfPageContent.vue';
import { resolveNativePdfRenderQueue } from '@app/modules/native-pdf-viewer/runtime/resolveNativePdfRenderQueue';
import type { IDocumentPreviewPageState } from '@app/utils/document-viewer/pagePreviewSource';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const activeUnmounts = new Set<() => void>();
const originalRequestAnimationFrame = window.requestAnimationFrame;

function mountPageContent(onVisualReady: (pageNumber: number) => void) {
    const host = document.createElement('div');
    document.body.append(host);
    const pageState = ref<IDocumentPreviewPageState>({
        failedRenderPx: 0,
        objectUrl: 'blob:page-3',
        renderedPx: 900,
        status: 'loaded',
        token: 1,
    });
    const TestHost = defineComponent({setup: () => () => h(NativePdfPageContent, {
        pageNumber: 3,
        pageState: pageState.value,
        visualCommitted: false,
        onVisualReady: (payload: {pageNumber: number}) => onVisualReady(payload.pageNumber),
    })});
    const app = createApp(TestHost);
    const ElementStub = defineComponent({setup: () => () => h('span')});
    app.component('UButton', ElementStub);
    app.component('UIcon', ElementStub);
    app.component('USkeleton', ElementStub);
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

afterEach(() => {
    for (const unmount of activeUnmounts) unmount();
    activeUnmounts.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    document.body.innerHTML = '';
});

describe('Native PDF viewer initial render scheduling', () => {
    it('keeps cold-open demand on the restored page, then restores distance ordering', () => {
        const activePages = new Set([
            1,
            2,
            3,
            4,
            5,
        ]);

        expect(resolveNativePdfRenderQueue({
            activePage: 3,
            activePages,
            deferAdjacentPages: true,
        })).toEqual([3]);
        expect(resolveNativePdfRenderQueue({
            activePage: 3,
            activePages,
            deferAdjacentPages: false,
        })).toEqual([
            3,
            2,
            4,
            1,
            5,
        ]);
    });

    it('reports the restored image ready only after it crosses two paint frames', async () => {
        vi.useFakeTimers();
        const readyPages: number[] = [];
        const harness = mountPageContent(pageNumber => readyPages.push(pageNumber));
        const initialImage = harness.host.querySelector<HTMLImageElement>('.native-pdf-page-image');
        expect(initialImage).not.toBeNull();
        initialImage?.dispatchEvent(new Event('load'));
        await vi.advanceTimersByTimeAsync(0);
        expect(readyPages).toEqual([]);

        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(0);
        expect(readyPages).toEqual([]);

        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(0);
        expect(readyPages).toEqual([3]);

        harness.unmount();
    });

    it('reports the restored image ready when the hidden window never delivers paint frames', async () => {
        window.requestAnimationFrame = () => {
            throw new Error('requestAnimationFrame must not be used while hidden');
        };
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        const readyPages: number[] = [];
        const harness = mountPageContent(pageNumber => readyPages.push(pageNumber));
        const initialImage = harness.host.querySelector<HTMLImageElement>('.native-pdf-page-image');
        expect(initialImage).not.toBeNull();
        initialImage?.dispatchEvent(new Event('load'));

        await vi.waitFor(() => expect(readyPages).toEqual([3]));

        harness.unmount();
    });
});
