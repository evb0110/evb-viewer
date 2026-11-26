import {
    parentPort,
    workerData,
} from 'node:worker_threads';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    createPdfPageOpsWasmRunner,
    executeDesktopPageOpsCommand,
} from '@node-runtime/pdfPageOpsWasmRunner';
import {getErrorMessage} from '@electron/utils/error';

interface IPdfPageOpsWorkerData {wasmModule: WebAssembly.Module;}

const port = parentPort;
if (!port || !workerData || typeof workerData !== 'object' || !('wasmModule' in workerData)) {
    throw new Error('Invalid PDF page-ops worker startup payload');
}

const runner = createPdfPageOpsWasmRunner((workerData as IPdfPageOpsWorkerData).wasmModule);

port.on('message', ({
    id,
    args,
    stagedOutputPath,
}: {
    id: number;
    args: string[];
    stagedOutputPath?: string;
}) => {
    try {
        const data = executeDesktopPageOpsCommand(
            runner,
            args,
            stagedOutputPath === undefined ? undefined : {stagedOutputPath},
        );
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
