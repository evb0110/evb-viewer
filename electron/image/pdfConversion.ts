import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { stageNativeCombineInputs } from '@electron/image/pdfCombineShared';
import { tryWritePdfFromInputPathsNative } from '@electron/image/tryCreatePdfFromInputPathsNative';
import {PdfCombineCapabilityError} from '@electron/image/pdfCombineErrors';
import type { IJobBrokerRunContext } from '@electron/resources/jobBroker';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
export {
    isPdfPath, isDjvuPath, isPdfOrImagePath, isSupportedOpenPath,
} from '@electron/utils/documentFileTypes';

export interface ICreatePdfFromInputPathsProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreatePdfFromInputPathsOptions {
    brokerRun?: IJobBrokerRunContext;
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;
    signal?: AbortSignal;
}

export function buildCombinedPdfOutputPath(inputPaths: string[]) {
    if (inputPaths.length === 0) {
        return 'combined.pdf';
    }

    const firstPath = inputPaths[0];
    if (!firstPath) {
        return 'combined.pdf';
    }
    const dir = dirname(firstPath);
    const stem = basename(firstPath, extname(firstPath));
    const outputName =
        inputPaths.length === 1 ? `${stem}.pdf` : `combined-${Date.now()}.pdf`;

    return join(dir, outputName);
}

export async function createPdfFileFromInputPaths(
    inputPaths: string[],
    outputPath: string,
    options?: ICreatePdfFromInputPathsOptions,
) {
    const normalizedPaths = inputPaths
        .filter((path) => path.length > 0);
    const normalizedOutputPath = typeof outputPath === 'string' ? outputPath : '';

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }
    if (!normalizedOutputPath) {
        throw new Error('No output file was provided');
    }

    const nativeOptions = {
        ...(options ?? {}),
        failureMode: 'capability-error' as const,
    };
    const staged = await stageNativeCombineInputs(normalizedPaths, options?.signal);
    let retainStagedInputs = false;
    try {
        const nativeWrote = await tryWritePdfFromInputPathsNative(
            staged.inputPaths,
            normalizedOutputPath,
            nativeOptions,
        );
        if (nativeWrote) {
            return normalizedOutputPath;
        }
        throw new PdfCombineCapabilityError(
            'native-failure',
            'Native PDF combine did not produce an output file for the path-backed input set',
            {operation: 'pdf-combine'},
        );
    } catch (error) {
        retainStagedInputs = getUnprovenNativeTerminationDetail(error) !== undefined;
        throw error;
    } finally {
        if (!retainStagedInputs) {
            await staged.cleanup();
        }
    }
}
