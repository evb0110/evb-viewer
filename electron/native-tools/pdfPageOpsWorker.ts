import {
    parentPort,
    workerData,
} from 'node:worker_threads';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    createPdfPageOpsWasmRunner,
    executeDesktopPageOpsCommand,
} from '@node-runtime/pdfPageOpsWasmRunner';
import {
    executeDesktopQpdfCommand,
    loadQpdfModuleFactory,
    type IExecuteDesktopQpdfOptions,
} from '@node-runtime/qpdfWasmRunner';
import {getErrorMessage} from '@electron/utils/error';

interface IPdfPageOpsWorkerData {
    kind?: 'page-ops';
    wasmModule: WebAssembly.Module;
}

interface IQpdfWorkerData {
    kind: 'qpdf';
    wasmModule: WebAssembly.Module;
    mjsPath: string;
}

type TWorkerData = IPdfPageOpsWorkerData | IQpdfWorkerData;

interface IQpdfWorkerRequest {
    id: number;
    args: string[];
    options?: IExecuteDesktopQpdfOptions;
}

const port = parentPort;
if (!port || !workerData || typeof workerData !== 'object' || !('wasmModule' in workerData)) {
    throw new Error('Invalid PDF WASM worker startup payload');
}

const startupData = workerData as TWorkerData;

if (startupData.kind === 'qpdf') {
    const factoryPromise = loadQpdfModuleFactory(startupData.mjsPath);
    port.on('message', async ({
        id,
        args,
        options,
    }: IQpdfWorkerRequest) => {
        try {
            const factory = await factoryPromise;
            const data = await executeDesktopQpdfCommand(
                startupData.wasmModule,
                factory,
                args,
                options,
            );
            port.postMessage({
                id,
                ok: true,
                data,
            });
        } catch (error) {
            const exitCode = typeof (error as {exitCode?: unknown})?.exitCode === 'number'
                ? (error as {exitCode: number}).exitCode
                : undefined;
            port.postMessage({
                id,
                ok: false,
                error: getErrorMessage(error),
                ...(hasNativeErrorCode(error) ? {nativeErrorCode: error.code} : {}),
                ...(exitCode === undefined ? {} : {exitCode}),
            });
        }
    });
} else {
    const runner = createPdfPageOpsWasmRunner(startupData.wasmModule);

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
}
