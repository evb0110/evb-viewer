import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { App } from 'electron';
import * as electron from 'electron';
import { getNativeToolBinaryPath } from '@electron/native-tools/getNativeToolBinaryPath';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import { getRuntimeTessdataDir } from '@electron/features/ocr/languageModels';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

export interface IOcrNativeToolPaths {
    tesseract: string;
    tessdata: string;
}

export interface IResolveOcrNativeToolPathsOptions {
    exists?: (path: string) => boolean;
    isPackaged: boolean;
    nativeToolsBase: string;
    platform?: NodeJS.Platform;
    platformArch: string;
    tessdataDir: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function isElectronAppPackaged() {
    return (electron as {app?: Pick<App, 'isPackaged'>}).app?.isPackaged === true;
}

export function resolveOcrNativeToolPaths(options: IResolveOcrNativeToolPathsOptions): IOcrNativeToolPaths {
    const pathExists = options.exists ?? existsSync;
    const tesseractPlatformDir = join(options.nativeToolsBase, 'tesseract', options.platformArch);
    const tesseract = getNativeToolBinaryPath({
        dir: tesseractPlatformDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'tesseract',
        platform: options.platform ?? process.platform,
    });
    return {
        tesseract,
        tessdata: options.tessdataDir,
    };
}

export function getOcrNativeToolPaths(): IOcrNativeToolPaths {
    const appIsPackaged = isElectronAppPackaged();
    return resolveOcrNativeToolPaths({
        isPackaged: appIsPackaged,
        nativeToolsBase: resolveNativeToolsBase(__dirname, appIsPackaged),
        platformArch: resolvePlatformArchTag(),
        tessdataDir: getRuntimeTessdataDir(),
    });
}
