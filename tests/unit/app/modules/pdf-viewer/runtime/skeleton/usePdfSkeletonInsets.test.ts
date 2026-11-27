import {
    createSSRApp,
    defineComponent,
    ref,
    watch,
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

async function mountSkeletonInsetsHarness(
    initialWidth: number | null = 600,
    initialHeight: number | null = 800,
): Promise<ISkeletonInsetsHarness> {
    const basePageWidth = ref<number | null>(initialWidth);
    const basePageHeight = ref<number | null>(initialHeight);
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
    it('derives stable page-relative insets purely from admitted base page dimensions', async () => {
        const { skeleton } = await mountSkeletonInsetsHarness();
        const expectedInsets: IContentInsets = {
            top: 80,
            right: 48,
            bottom: 80,
            left: 48,
        };

        expect(skeleton.skeletonContentInsets.value).toEqual(expectedInsets);
        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 120,
            right: 72,
            bottom: 120,
            left: 72,
        });
    });

    it('returns null before page dimensions are admitted and derives them once admitted', async () => {
        const {
            basePageHeight,
            basePageWidth,
            skeleton,
        } = await mountSkeletonInsetsHarness(null, null);

        expect(skeleton.skeletonContentInsets.value).toBeNull();
        expect(skeleton.scaledSkeletonPadding.value).toBeNull();

        basePageWidth.value = 600;
        basePageHeight.value = 800;

        expect(skeleton.skeletonContentInsets.value).toEqual({
            top: 80,
            right: 48,
            bottom: 80,
            left: 48,
        });
        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 120,
            right: 72,
            bottom: 120,
            left: 72,
        });
    });

    it('recomputes fallback insets reactively without write side effects in scaledSkeletonPadding', async () => {
        const {
            basePageHeight,
            basePageWidth,
            skeleton,
        } = await mountSkeletonInsetsHarness();
        const insetsWatcher = vi.fn();
        watch(skeleton.skeletonContentInsets, insetsWatcher, { flush: 'sync' });

        // Reading scaledSkeletonPadding must not trigger reactive writes to skeletonContentInsets.
        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 120,
            right: 72,
            bottom: 120,
            left: 72,
        });
        expect(insetsWatcher).not.toHaveBeenCalled();

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
