import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    detectSourceDpi as detectCoreSourceDpi,
    detectSourceDpiDetails as detectCoreSourceDpiDetails,
    type TSourceDpiLog,
} from '@evb/scan-cleanup/core/sourceDpiDetection';
export {detectSourceDpiFromPageSizes} from '@evb/scan-cleanup/core/types';
export type {TSourceDpiLog};

export function detectSourceDpiDetails(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
    onProgress?: (completedPages: number, totalPages: number) => void,
) {
    return detectCoreSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        log,
        commandEnv,
        signal,
        pages,
        onProgress,
        runNativeToolCommand,
    );
}

export function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
) {
    return detectCoreSourceDpi(
        pdfPath,
        pdfimagesBinary,
        log,
        commandEnv,
        signal,
        pages,
        runNativeToolCommand,
    );
}
