import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    LARGE_PDF_MUTATION_THRESHOLD_BYTES,
    LARGE_PDF_MUTATION_QUEUE_LIMIT,
    withLargePdfMutationAdmission,
} from '@electron/features/documents/main/withLargePdfMutationAdmission';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(settle => {
        resolve = settle;
    });
    return {
        promise,
        resolve,
    };
}

describe('withLargePdfMutationAdmission', () => {
    it('serializes native parsing above the renderer-safe threshold', async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const secondOperation = vi.fn(async () => undefined);
        const signal = new AbortController().signal;

        const first = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            signal,
            async () => {
                firstStarted.resolve();
                await releaseFirst.promise;
            },
        );
        await firstStarted.promise;
        const second = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            signal,
            secondOperation,
        );
        await Promise.resolve();

        try {
            expect(secondOperation).not.toHaveBeenCalled();
        } finally {
            releaseFirst.resolve();
        }
        await Promise.all([
            first,
            second,
        ]);
        expect(secondOperation).toHaveBeenCalledOnce();
    });

    it('does not start an aborted large mutation after its queue wait', async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const queuedOperation = vi.fn(async () => undefined);
        const queuedController = new AbortController();

        const first = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            new AbortController().signal,
            async () => {
                firstStarted.resolve();
                await releaseFirst.promise;
            },
        );
        await firstStarted.promise;
        const queued = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            queuedController.signal,
            queuedOperation,
        );
        queuedController.abort(new Error('Document closed'));

        const laterOperation = vi.fn(async () => undefined);
        const later = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            new AbortController().signal,
            laterOperation,
        );
        try {
            await expect(queued).rejects.toThrow('Document closed');
            expect(queuedOperation).not.toHaveBeenCalled();
            await Promise.resolve();
            expect(laterOperation).not.toHaveBeenCalled();
        } finally {
            releaseFirst.resolve();
        }

        await Promise.all([
            first,
            later,
        ]);
        expect(laterOperation).toHaveBeenCalledOnce();
    });

    it('waits for an active aborted mutation to finish cleanup before settling', async () => {
        const operationStarted = deferred();
        const operationSawAbort = deferred();
        const releaseCleanup = deferred();
        const controller = new AbortController();
        controller.signal.addEventListener('abort', operationSawAbort.resolve, {once: true});

        const active = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            controller.signal,
            async signal => {
                operationStarted.resolve();
                signal.addEventListener('abort', operationSawAbort.resolve, {once: true});
                await releaseCleanup.promise;
                throw signal.reason;
            },
        );
        let settled = false;
        void active.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await operationStarted.promise;

        try {
            controller.abort(new Error('Document closed during native parsing'));
            await operationSawAbort.promise;
            await Promise.resolve();

            expect(settled).toBe(false);
        } finally {
            releaseCleanup.resolve();
        }
        await expect(active).rejects.toThrow('Document closed during native parsing');
        expect(settled).toBe(true);
    });

    it('rejects an already-aborted large mutation without starting it', async () => {
        const controller = new AbortController();
        const operation = vi.fn(async () => undefined);
        controller.abort(new Error('Already closed'));

        await expect(withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            controller.signal,
            operation,
        )).rejects.toThrow('Already closed');
        expect(operation).not.toHaveBeenCalled();
    });

    it('does not queue documents at or below 512 MiB', async () => {
        const largeStarted = deferred();
        const releaseLarge = deferred();
        const thresholdOperation = vi.fn(async () => undefined);

        const large = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            new AbortController().signal,
            async () => {
                largeStarted.resolve();
                await releaseLarge.promise;
            },
        );
        await largeStarted.promise;
        try {
            await withLargePdfMutationAdmission(
                LARGE_PDF_MUTATION_THRESHOLD_BYTES,
                new AbortController().signal,
                thresholdOperation,
            );

            expect(thresholdOperation).toHaveBeenCalledOnce();
        } finally {
            releaseLarge.resolve();
        }
        await large;
    });

    it('rejects admissions beyond the bounded queue', async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const first = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            new AbortController().signal,
            async () => {
                firstStarted.resolve();
                await releaseFirst.promise;
            },
        );
        await firstStarted.promise;
        const queued = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            new AbortController().signal,
            async () => undefined,
        );
        const rejected = withLargePdfMutationAdmission(
            LARGE_PDF_MUTATION_THRESHOLD_BYTES + 1,
            new AbortController().signal,
            async () => undefined,
        );

        try {
            await expect(rejected).rejects.toThrow(
                `maximum ${String(LARGE_PDF_MUTATION_QUEUE_LIMIT)} queued operation`,
            );
        } finally {
            releaseFirst.resolve();
        }
        await Promise.all([
            first,
            queued,
        ]);
    });
});
