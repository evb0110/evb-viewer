import {parentPort, workerData} from 'worker_threads';
import {combinePagesIntoMultiPageTiffLocal} from '@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal';
import {convertRenderedPpmToPngJs} from '@electron/features/image-export/main/convertPpmToPngJs';
import type {IWorkerTaskErrorFrame} from '@electron/utils/workerTask';
import {createWorkerTaskErrorFrame} from '@electron/utils/workerTask';
import {getErrorMessage} from '@electron/utils/error';

interface ITiffCombineWorkerData {
    task?: unknown;
    combineThreads?: unknown;
    defaultDpi?: unknown;
    deleteSourcePages?: unknown;
    pagePaths?: unknown;
    outputPath?: unknown;
    tempPath?: unknown;
    sourcePath?: unknown;
    pngPath?: unknown;
    dpi?: unknown;
}

type TImageExportWorkerInput =
    | {
          task: 'tiff-combine';
          combineThreads: number | undefined;
          defaultDpi: number | undefined;
          deleteSourcePages: boolean;
          pagePaths: string[];
          outputPath: string;
          tempPath: string | undefined;
      }
    | {
          task: 'ppm-to-png';
          sourcePath: string;
          pngPath: string;
          dpi: number;
      };

type TTiffCombineWorkerResult =
    | {
          type: 'result';
          ok: true;
      }
    | {
          type: 'result';
          ok: false;
          error: string;
          errorFrame?: IWorkerTaskErrorFrame;
      };

interface ITiffCombineWorkerCancelMessage {
    type: 'cancel';
}

function getWorkerInput(): TImageExportWorkerInput {
    const input = workerData as ITiffCombineWorkerData | undefined;
    if (input?.task === 'ppm-to-png') {
        if (
            typeof input.sourcePath !== 'string' ||
            input.sourcePath.trim().length === 0 ||
            typeof input.pngPath !== 'string' ||
            input.pngPath.trim().length === 0 ||
            typeof input.dpi !== 'number' ||
            !Number.isFinite(input.dpi) ||
            input.dpi <= 0
        ) {
            throw new Error('Invalid PPM-to-PNG worker payload');
        }
        return {
            task: 'ppm-to-png',
            sourcePath: input.sourcePath,
            pngPath: input.pngPath,
            dpi: input.dpi,
        };
    }

    if (!Array.isArray(input?.pagePaths) || typeof input.outputPath !== 'string') {
        throw new Error('Invalid TIFF combine worker payload');
    }
    const pagePaths: string[] = [];
    for (const [index, path] of input.pagePaths.entries()) {
        if (typeof path !== 'string' || path.trim().length === 0) {
            throw new Error(`Invalid TIFF combine page path at index ${index}`);
        }
        pagePaths.push(path);
    }
    if (pagePaths.length === 0) {
        throw new Error('TIFF combine worker requires at least one page path');
    }
    return {
        task: 'tiff-combine',
        combineThreads:
            typeof input.combineThreads === 'number' && Number.isInteger(input.combineThreads) && input.combineThreads > 0
                ? input.combineThreads
                : undefined,
        defaultDpi:
            typeof input.defaultDpi === 'number' && Number.isFinite(input.defaultDpi) && input.defaultDpi > 0
                ? input.defaultDpi
                : undefined,
        deleteSourcePages: input.deleteSourcePages === true,
        pagePaths,
        outputPath: input.outputPath,
        tempPath: typeof input.tempPath === 'string' ? input.tempPath : undefined,
    };
}

function isCancelMessage(message: unknown): message is ITiffCombineWorkerCancelMessage {
    return Boolean(message) && typeof message === 'object' && (message as {type?: unknown}).type === 'cancel';
}

async function run() {
    if (!parentPort) {
        throw new Error('TIFF combine worker started without a parentPort');
    }

    const abortController = new AbortController();
    parentPort.on('message', (message: unknown) => {
        if (isCancelMessage(message)) {
            abortController.abort(new DOMException('Image export worker canceled', 'AbortError'));
        }
    });

    try {
        const input = getWorkerInput();
        if (input.task === 'ppm-to-png') {
            await convertRenderedPpmToPngJs(input.sourcePath, input.pngPath, input.dpi, abortController.signal);
        } else {
            await combinePagesIntoMultiPageTiffLocal(input.pagePaths, input.outputPath, {
                deleteSourcePages: input.deleteSourcePages,
                ...(input.combineThreads === undefined ? {} : {combineThreads: input.combineThreads}),
                ...(input.defaultDpi === undefined ? {} : {defaultDpi: input.defaultDpi}),
                ...(input.tempPath === undefined ? {} : {tempPath: input.tempPath}),
                signal: abortController.signal,
            });
        }
        parentPort.postMessage({
            type: 'result',
            ok: true,
        } satisfies TTiffCombineWorkerResult);
    } catch (error) {
        parentPort.postMessage({
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
            errorFrame: createWorkerTaskErrorFrame(error, {source: 'image-export:tiff-combine-worker'}),
        } satisfies TTiffCombineWorkerResult);
    }
}

await run();
