import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    createPdfPageSizeStore as createCorePdfPageSizeStore,
    parsePdfInfoPageGeometry,
    parsePdfPageSizesPayload,
    readPdfPageSizes as readCorePdfPageSizes,
    type IPdfPageSize,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {IReadPdfPageSizesOptions as ICoreReadPdfPageSizesOptions} from '@evb/scan-cleanup/core/types';

export type {
    IPdfPageSize,
    IPdfPageSizeStore,
};
export {
    parsePdfInfoPageGeometry, parsePdfPageSizesPayload,
};

export interface IReadPdfPageSizesOptions extends Omit<ICoreReadPdfPageSizesOptions, 'log' | 'runCommand'> {
    log?: ICoreReadPdfPageSizesOptions['log'];
    runCommand?: typeof runNativeToolCommand;
}

export async function readPdfPageSizes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    return readCorePdfPageSizes(pdfPath, {
        ...options,
        log: options.log ?? (() => undefined),
        runCommand: options.runCommand ?? runNativeToolCommand,
    });
}

/** Open the bounded native page-geometry reader used by long-document jobs. */
export function createPdfPageSizeStore(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    return createCorePdfPageSizeStore(pdfPath, {
        ...options,
        log: options.log ?? (() => undefined),
        runCommand: options.runCommand ?? runNativeToolCommand,
    });
}
