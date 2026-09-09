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
    unpaper?: string;
}

export interface IResolveOcrNativeToolPathsOptions {
    exists?: (path: string) => boolean;
    isPackaged: boolean;
    nativeToolsBase: string;
    platform?: NodeJS.Platform;
    platformArch: string;
    tessdataDir: string;
}

interface IOcrToolBinaryPathOptions {
    dir: string;
    exists: (path: string) => boolean;
    isPackaged: boolean;
    name: string;
    optional?: boolean | undefined;
    platform?: NodeJS.Platform | undefined;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function isElectronAppPackaged() {
    return (electron as {app?: Pick<App, 'isPackaged'>}).app?.isPackaged === true;
}

function getOcrToolBinaryPath(options: IOcrToolBinaryPathOptions) {
    const binaryOptions: Parameters<typeof getNativeToolBinaryPath>[0] = {
        dir: options.dir,
        exists: options.exists,
        isPackaged: options.isPackaged,
        name: options.name,
    };
    if (options.optional !== undefined) {
        binaryOptions.optional = options.optional;
    }
    if (options.platform !== undefined) {
        binaryOptions.platform = options.platform;
    }
    return getNativeToolBinaryPath(binaryOptions);
}

export function resolveOcrNativeToolPaths(options: IResolveOcrNativeToolPathsOptions): IOcrNativeToolPaths {
    const pathExists = options.exists ?? existsSync;
    const tesseractPlatformDir = join(options.nativeToolsBase, 'tesseract', options.platformArch);
    const tesseract = getOcrToolBinaryPath({
        dir: tesseractPlatformDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'tesseract',
        platform: options.platform,
    });
    const unpaper = getOcrToolBinaryPath({
        dir: tesseractPlatformDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'unpaper',
        optional: true,
        platform: options.platform,
    }) || undefined;

    const paths: IOcrNativeToolPaths = {
        tesseract,
        tessdata: options.tessdataDir,
    };
    if (unpaper !== undefined) {
        paths.unpaper = unpaper;
    }
    return paths;
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
