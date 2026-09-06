import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    resetCoordinatedPdfPageRendersForTest,
    runCoordinatedPdfPageRender,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';

function flushAsyncQueue() {
    return Promise.resolve().then(() => Promise.resolve());
}

function createRenderTask() {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    const cancel = vi.fn(() => {
        const error = new Error('cancelled');
        error.name = 'RenderingCancelledException';
        rejectPromise(error);
    });

    return {
        cancel,
        resolve: resolvePromise,
        task: {
            cancel,
            promise,
        },
    };
}

function createPdfPage() {
    return {} as IPdfPage;
}

describe('runCoordinatedPdfPageRender', () => {
    afterEach(() => {
        resetCoordinatedPdfPageRendersForTest();
    });

    it('waits for an equal-priority active render instead of cancelling it', async () => {
        const pdfPage = createPdfPage();
        const firstRender = createRenderTask();
        const secondRender = createRenderTask();
        let didStartSecondRender = false;

        const firstRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail-current',
            pageNumber: 1,
            pdfPage,
            priority: 100,
            startRender: () => firstRender.task,
        });
        await flushAsyncQueue();

        const secondRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage,
            priority: 100,
            startRender: () => {
                didStartSecondRender = true;
                return secondRender.task;
            },
        });
        await flushAsyncQueue();

        expect(firstRender.cancel).not.toHaveBeenCalled();
        expect(didStartSecondRender).toBe(false);

        firstRender.resolve();
        await firstRun;
        await flushAsyncQueue();

        expect(didStartSecondRender).toBe(true);
        secondRender.resolve();
        await secondRun;
    });

    it('preempts a lower-priority active render', async () => {
        const pdfPage = createPdfPage();
        const firstRender = createRenderTask();
        const secondRender = createRenderTask();
        let didStartSecondRender = false;

        const firstRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage,
            priority: 10,
            startRender: () => firstRender.task,
        });
        const firstResult = firstRun.catch(error => error);
        await flushAsyncQueue();

        const secondRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage,
            priority: 100,
            startRender: () => {
                didStartSecondRender = true;
                return secondRender.task;
            },
        });
        await flushAsyncQueue();

        expect(firstRender.cancel).toHaveBeenCalledTimes(1);

        const firstError = await firstResult;
        expect(firstError).toMatchObject({ name: 'RenderingCancelledException' });
        await flushAsyncQueue();

        expect(didStartSecondRender).toBe(true);
        secondRender.resolve();
        await secondRun;
    });
});
