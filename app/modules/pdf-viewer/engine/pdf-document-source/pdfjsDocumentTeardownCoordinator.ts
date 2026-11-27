import {BrowserLogger} from '@app/utils/browserLogger';

interface IPdfjsDocumentTeardown {
    message: string;
    run: () => Promise<void>;
}

interface IPdfjsDocumentTeardownLane {
    barrier: Promise<void>;
}

function createAbortError() {
    return new DOMException('PDF document load was superseded', 'AbortError');
}

async function waitForBarrier(barrier: Promise<void>, signal?: AbortSignal) {
    if (!signal) {
        await barrier;
        return;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = () => reject(createAbortError());
        signal.addEventListener('abort', abort, {once: true});
        void barrier.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}

export function createPdfjsDocumentTeardownCoordinator() {
    const lanes = new Map<string, IPdfjsDocumentTeardownLane>();

    function track(key: string, teardown: IPdfjsDocumentTeardown) {
        const lane = lanes.get(key) ?? {barrier: Promise.resolve()};
        const tracked = lane.barrier.then(teardown.run).catch((error) => {
            BrowserLogger.warn('pdf-document', teardown.message, error);
        });
        lane.barrier = tracked;
        lanes.set(key, lane);
        void tracked.finally(() => {
            if (lanes.get(key)?.barrier === tracked) {
                lanes.delete(key);
            }
        });
    }

    async function waitForIdle(key: string, signal?: AbortSignal) {
        for (;;) {
            const activeBarrier = lanes.get(key)?.barrier;
            if (!activeBarrier) {
                return;
            }
            await waitForBarrier(activeBarrier, signal);
            if (activeBarrier === lanes.get(key)?.barrier || !lanes.has(key)) {
                return;
            }
        }
    }

    return {
        track,
        waitForIdle,
    };
}

export const pdfjsDocumentTeardownCoordinator = createPdfjsDocumentTeardownCoordinator();
