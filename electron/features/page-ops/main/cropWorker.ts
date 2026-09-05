import {
    parentPort,
    workerData,
} from 'worker_threads';
import type {TCropWorkerResult} from '@electron/features/page-ops/main/cropWorkerProtocol';
import {
    decodeCropWorkerControlMessage,
    decodeCropWorkerInput,
} from '@electron/features/page-ops/main/cropWorkerProtocol';
import {
    cropPagesLocal,
    removeCropFromPagesLocal,
} from '@electron/features/page-ops/main/cropLocal';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { getErrorMessage } from '@electron/utils/error';

function getInput() {
    const input = decodeCropWorkerInput(workerData);
    if (!input) {
        throw new Error('Invalid crop worker payload');
    }
    return input;
}

async function run() {
    if (!parentPort) {
        throw new Error('Crop worker started without a parentPort');
    }

    const abortController = new AbortController();
    parentPort.on('message', (message: unknown) => {
        if (decodeCropWorkerControlMessage(message)) {
            abortController.abort(new DOMException('Crop worker canceled', 'AbortError'));
        }
    });

    try {
        const input = getInput();
        switch (input.type) {
            case 'crop':
                await cropPagesLocal(input.workingCopyPath, input.pages, input.margins, abortController.signal);
                parentPort.postMessage({
                    type: 'result',
                    ok: true,
                } satisfies TCropWorkerResult);
                break;
            case 'removeCrop':
                await removeCropFromPagesLocal(input.workingCopyPath, input.pages, abortController.signal);
                parentPort.postMessage({
                    type: 'result',
                    ok: true,
                } satisfies TCropWorkerResult);
                break;
        }
    } catch (error) {
        parentPort.postMessage({
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
            errorFrame: createWorkerTaskErrorFrame(error, {source: 'page-ops:crop-worker'}),
        } satisfies TCropWorkerResult);
    }
}

await run();
