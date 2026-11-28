import {parentPort, workerData} from 'node:worker_threads';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {createPdfSearchWasmRunner} from '@electron/features/search/pdfSearchWasmRunner';
import {
    createPdfSearchWorkerIndexCache,
    executePdfSearchWorkerCommand,
    type TPdfSearchWorkerCommand,
} from '@electron/features/search/pdfSearchWorkerOps';
import {getErrorMessage} from '@electron/utils/error';

interface IPdfSearchWorkerData {
    wasmModule: WebAssembly.Module;
}

type TWorkerMessage =
    | {
          control: 'evict';
          indexPath?: string;
      }
    | {
          id: number;
          command: TPdfSearchWorkerCommand;
      };

const port = parentPort;
if (!port || !workerData || typeof workerData !== 'object' || !('wasmModule' in workerData)) {
    throw new Error('Invalid PDF search worker startup payload');
}

const runner = createPdfSearchWasmRunner((workerData as IPdfSearchWorkerData).wasmModule);
const indexCache = createPdfSearchWorkerIndexCache();

port.on('message', async (message: TWorkerMessage) => {
    if ('control' in message) {
        if (message.control === 'evict') {
            indexCache.evict(message.indexPath);
        }
        return;
    }
    const {id, command} = message;
    try {
        const data = await executePdfSearchWorkerCommand(runner, command, {indexCache});
        port.postMessage({
            id,
            ok: true,
            data,
        });
    } catch (error) {
        port.postMessage({
            id,
            ok: false,
            error: getErrorMessage(error),
            ...(hasNativeErrorCode(error) ? {nativeErrorCode: error.code} : {}),
        });
    }
});
