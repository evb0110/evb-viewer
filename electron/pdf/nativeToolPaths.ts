import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { IPopplerRuntimePaths } from '@electron/native-tools/buildPopplerEnv';
import { getNativeToolBinaryPath } from '@electron/native-tools/getNativeToolBinaryPath';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

export interface IPdfNativeToolPaths extends IPopplerRuntimePaths {
    pdfinfo: string;
    pdftoppm: string;
    pdftotext: string;
    pdfimages?: string;
    qpdf: string;
}

export interface IResolvePdfNativeToolPathsOptions {
    exists?: (path: string) => boolean;
    isPackaged: boolean;
    nativeToolsBase: string;
    platform?: NodeJS.Platform;
    platformArch: string;
}

interface IPdfToolBinaryPathOptions {
    dir: string;
    exists: (path: string) => boolean;
    isPackaged: boolean;
    name: string;
    optional?: boolean | undefined;
    platform?: NodeJS.Platform | undefined;
}

function resolveModuleDirectory(moduleUrl: string | undefined) {
    return moduleUrl === undefined ? process.cwd() : dirname(fileURLToPath(moduleUrl));
}

const __dirname = resolveModuleDirectory((import.meta as ImportMeta & {url?: string}).url);

function isElectronAppPackaged() {
    return __dirname.includes('app.asar');
}

function getPdfToolBinaryPath(options: IPdfToolBinaryPathOptions) {
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

export function resolvePdfNativeToolPaths(options: IResolvePdfNativeToolPathsOptions): IPdfNativeToolPaths {
    const pathExists = options.exists ?? existsSync;
    const popplerDir = join(options.nativeToolsBase, 'poppler', options.platformArch);
    const pdfinfo = getPdfToolBinaryPath({
        dir: popplerDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'pdfinfo',
        platform: options.platform,
    });
    const pdftoppm = getPdfToolBinaryPath({
        dir: popplerDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'pdftoppm',
        platform: options.platform,
    });
    const pdftotext = getPdfToolBinaryPath({
        dir: popplerDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'pdftotext',
        platform: options.platform,
    });
    const pdfimages = getPdfToolBinaryPath({
        dir: popplerDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'pdfimages',
        optional: true,
        platform: options.platform,
    }) || undefined;
    const popplerDataDirCandidate = join(popplerDir, 'share', 'poppler');
    const popplerFontConfigDirCandidate = join(popplerDir, 'etc', 'fonts');
    const popplerDataDir = pathExists(popplerDataDirCandidate) ? popplerDataDirCandidate : undefined;
    const popplerFontConfigDir = pathExists(popplerFontConfigDirCandidate) ? popplerFontConfigDirCandidate : undefined;

    const qpdfDir = join(options.nativeToolsBase, 'qpdf', options.platformArch);
    const qpdf = getPdfToolBinaryPath({
        dir: qpdfDir,
        exists: pathExists,
        isPackaged: options.isPackaged,
        name: 'qpdf',
        platform: options.platform,
    });

    const paths: IPdfNativeToolPaths = {
        pdfinfo,
        pdftoppm,
        pdftotext,
        qpdf,
    };
    if (pdfimages !== undefined) {
        paths.pdfimages = pdfimages;
    }
    if (popplerDataDir !== undefined) {
        paths.popplerDataDir = popplerDataDir;
    }
    if (popplerFontConfigDir !== undefined) {
        paths.popplerFontConfigDir = popplerFontConfigDir;
    }

    return paths;
}

export function getPdfNativeToolPaths(): IPdfNativeToolPaths {
    const appIsPackaged = isElectronAppPackaged();
    return resolvePdfNativeToolPaths({
        isPackaged: appIsPackaged,
        nativeToolsBase: resolveNativeToolsBase(__dirname, appIsPackaged),
        platformArch: resolvePlatformArchTag(),
    });
}
