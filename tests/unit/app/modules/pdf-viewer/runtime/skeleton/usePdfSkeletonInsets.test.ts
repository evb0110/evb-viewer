import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    createSSRApp,
    defineComponent,
    ref,
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfSkeletonInsets } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import type { IContentInsets } from '@app/types/pdfUi';

interface ISkeletonInsetsHarness {
    basePageHeight: ReturnType<typeof ref<number | null>>;
    basePageWidth: ReturnType<typeof ref<number | null>>;
    skeleton: ReturnType<typeof usePdfSkeletonInsets>;
}

async function mountSkeletonInsetsHarness(): Promise<ISkeletonInsetsHarness> {
    const basePageWidth = ref<number | null>(600);
    const basePageHeight = ref<number | null>(800);
    const effectiveScale = ref(1.5);
    let skeleton: ReturnType<typeof usePdfSkeletonInsets> | null = null;
    const app = createSSRApp(defineComponent({setup() {
        skeleton = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);
        return () => null;
    }}));

    await renderToString(app);

    if (!skeleton) {
        throw new Error('Failed to mount skeleton insets harness');
    }

    return {
        basePageHeight,
        basePageWidth,
        skeleton,
    };
}

describe('usePdfSkeletonInsets', () => {
    it('uses stable page-relative insets without probing page text', async () => {
        const { skeleton } = await mountSkeletonInsetsHarness();
        const getTextContent = vi.fn();
        const pdfPage = Object.assign(Object.create(null) as IPdfPage, { getTextContent });

        await skeleton.computeSkeletonInsets(pdfPage, 1, () => 1);

        const expectedInsets: IContentInsets = {
            top: 80,
            right: 48,
            bottom: 80,
            left: 48,
        };

        expect(getTextContent).not.toHaveBeenCalled();
        expect(skeleton.skeletonContentInsets.value).toEqual(expectedInsets);
        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 120,
            right: 72,
            bottom: 120,
            left: 72,
        });
    });

    it('ignores stale skeleton inset computations', async () => {
        const { skeleton } = await mountSkeletonInsetsHarness();
        const pdfPage = {} as IPdfPage;

        await skeleton.computeSkeletonInsets(pdfPage, 1, () => 2);

        expect(skeleton.skeletonContentInsets.value).toBeNull();
    });

    it('recomputes cached fallback insets when base page metrics change', async () => {
        const {
            basePageHeight,
            basePageWidth,
            skeleton,
        } = await mountSkeletonInsetsHarness();
        const pdfPage = {} as IPdfPage;

        await skeleton.computeSkeletonInsets(pdfPage, 1, () => 1);
        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 120,
            right: 72,
            bottom: 120,
            left: 72,
        });

        basePageWidth.value = 1_200;
        basePageHeight.value = 400;

        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 60,
            right: 144,
            bottom: 60,
            left: 144,
        });
        expect(skeleton.skeletonContentInsets.value).toEqual({
            top: 40,
            right: 96,
            bottom: 40,
            left: 96,
        });
    });
});
