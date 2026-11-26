import {
    parentPort,
    workerData,
} from 'node:worker_threads';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {createPdfSearchWasmRunner} from '@electron/features/search/pdfSearchWasmRunner';
import {
    executePdfSearchWorkerCommand,
    type TPdfSearchWorkerCommand,
} from '@electron/features/search/pdfSearchWorkerOps';
import {getErrorMessage} from '@electron/utils/error';

interface IPdfSearchWorkerData {wasmModule: WebAssembly.Module;}

const port = parentPort;
if (!port || !workerData || typeof workerData !== 'object' || !('wasmModule' in workerData)) {
    throw new Error('Invalid PDF search worker startup payload');
}

const runner = createPdfSearchWasmRunner((workerData as IPdfSearchWorkerData).wasmModule);

port.on('message', async ({
    id,
    command,
}: {
    id: number;
    command: TPdfSearchWorkerCommand;
}) => {
    try {
        const data = await executePdfSearchWorkerCommand(runner, command);
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
