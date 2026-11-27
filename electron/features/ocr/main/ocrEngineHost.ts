import {Worker} from 'node:worker_threads';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {decodeOcrEngineHostRequest, type TOcrEngineHostEvent} from '@electron/features/ocr/main/ocrEngineHostProtocol';

/**
 * The OCR utility process. It runs each engine lane as a worker thread, so a
 * lane busy inside Tesseract can still be ended from here, and it exits when
 * main asks, which returns every byte the engines held to the system.
 */
interface IUtilityParentPort {
    on(eventName: 'message', listener: (event: {data: unknown}) => void): unknown;
    postMessage(value: unknown): void;
}

function isUtilityParentPort(value: unknown): value is IUtilityParentPort {
    return (
        typeof value === 'object' &&
        value !== null &&
        'on' in value &&
        typeof value.on === 'function' &&
        'postMessage' in value &&
        typeof value.postMessage === 'function'
    );
}

const rawParentPort: unknown = process.parentPort;
if (!isUtilityParentPort(rawParentPort)) {
    throw new Error('OCR engine host started without a parent port');
}
const parentPort = rawParentPort;
const lanes = new Map<number, Worker>();

// Set once main asked this process to exit; it then takes no more work.
let shuttingDown = false;

const send = (event: TOcrEngineHostEvent) => {
    try {
        parentPort.postMessage(event);
    } catch {
        // The parent is going away and this process with it.
    }
};

const laneFailed = (lane: number, error: unknown) =>
    send({
        type: 'error',
        lane,
        message: getErrorMessage(error),
    });

parentPort.on('message', ({data}) => {
    const message = decodeOcrEngineHostRequest(data);
    if (!message || shuttingDown) {
        return;
    }
    switch (message.type) {
        case 'start': {
            const {lane} = message;
            if (lanes.has(lane)) {
                return;
            }
            let worker: Worker;
            try {
                worker = new Worker(message.workerPath, {workerData: message.workerData});
            } catch (error) {
                laneFailed(lane, error);
                send({
                    type: 'exit',
                    lane,
                    code: 1,
                });
                return;
            }
            lanes.set(lane, worker);
            worker.on('message', (reply) =>
                send({
                    type: 'reply',
                    lane,
                    reply,
                }),
            );
            worker.on('error', (error: unknown) => laneFailed(lane, error));
            worker.on('exit', (code) => {
                lanes.delete(lane);
                send({
                    type: 'exit',
                    lane,
                    code,
                });
            });
            return;
        }
        case 'run': {
            // As with a worker thread, a page sent to a lane that has exited is dropped;
            // main has its exit already.
            const worker = lanes.get(message.lane);
            if (!worker) {
                return;
            }
            const {image} = message.message.request;
            const transfer = image instanceof Uint8Array && image.buffer instanceof ArrayBuffer ? [image.buffer] : [];
            try {
                worker.postMessage(message.message, transfer);
            } catch (error) {
                // Only this lane's page fails; main ends the lane.
                laneFailed(message.lane, error);
            }
            return;
        }
        case 'end': {
            // A worker inside Tesseract cannot read messages; terminating it is
            // how a busy lane is canceled. A lane this process does not have
            // has exited, so main is told so rather than left waiting.
            const worker = lanes.get(message.lane);
            if (worker) {
                void worker.terminate();
            } else {
                send({
                    type: 'exit',
                    lane: message.lane,
                    code: 1,
                });
            }
            return;
        }
        case 'shutdown':
            shuttingDown = true;
            void Promise.allSettled(Array.from(lanes.values(), (worker) => worker.terminate())).finally(() => process.exit(0));
            return;
    }
});
