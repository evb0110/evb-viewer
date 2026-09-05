import {
    effectScope,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createPdfAnnotationOwnershipRefreshWatch} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationOwnershipRefreshWatch';

function createHarness(nextTick: () => Promise<void>) {
    const pdfDocument = ref<object | null>({});
    const renderVisiblePages = vi.fn(async () => {});
    const storeOwnedPdfAnnotationIds = ref<ReadonlySet<string>>(new Set());
    const annotationProjectionReady = ref(true);
    const scope = effectScope();
    const stopWatch = scope.run(() => createPdfAnnotationOwnershipRefreshWatch({
        documentSession: {pdfDocument: pdfDocument as never} as never,
        viewport: {visibleRange: ref({
            start: 1,
            end: 1,
        })} as never,
        rendering: {renderVisiblePages} as never,
        storeOwnedPdfAnnotationIds,
        annotationProjectionReady,
        nextTick,
    }));
    if (!stopWatch) {
        throw new Error('Expected ownership refresh watch');
    }
    return {
        annotationProjectionReady,
        pdfDocument,
        renderVisiblePages,
        scope,
        stopWatch,
    };
}

describe('createPdfAnnotationOwnershipRefreshWatch', () => {
    it('does not render after its scope is disposed while Vue is settling', async () => {
        const pendingNextTick = Promise.withResolvers<undefined>();
        const harness = createHarness(() => pendingNextTick.promise);

        harness.scope.stop();
        pendingNextTick.resolve(undefined);
        await pendingNextTick.promise;
        await Promise.resolve();

        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        harness.stopWatch();
    });

    it('does not render a page from a document replaced during Vue settling', async () => {
        const pendingNextTick = Promise.withResolvers<undefined>();
        const harness = createHarness(() => pendingNextTick.promise);
        const replacementDocument = {};

        harness.pdfDocument.value = replacementDocument;
        pendingNextTick.resolve(undefined);
        await pendingNextTick.promise;
        await Promise.resolve();

        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        harness.scope.stop();
        harness.stopWatch();
    });
});
