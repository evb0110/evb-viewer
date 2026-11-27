import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveNativeToolsBase} from '@electron/native-tools/resolveNativeToolsBase';
import {resolvePlatformArchTag} from '@electron/utils/platformArch';

const __dirname = dirname(fileURLToPath(import.meta.url));

function isPackagedElectronMain() {
    return __dirname.includes('app.asar');
}

export function resolveMacOsPdfPrintDialogBinary(
    options: {
        cwd?: string;
        exists?: (path: string) => boolean;
        isPackaged?: boolean;
        moduleDir?: string;
        nativeToolsBase?: string;
        platformArch?: string;
    } = {},
) {
    const pathExists = options.exists ?? existsSync;
    const isPackaged = options.isPackaged ?? isPackagedElectronMain();
    const platformArch = options.platformArch ?? resolvePlatformArchTag({allowedPlatforms: ['darwin']});
    const nativeToolsBase = options.nativeToolsBase ?? resolveNativeToolsBase(options.moduleDir ?? __dirname, isPackaged);
    const packagedCandidate = join(nativeToolsBase, 'pdf-print-dialog', platformArch, 'bin', 'pdf-print-dialog');
    if (isPackaged || pathExists(packagedCandidate)) {
        return packagedCandidate;
    }
    return join(options.cwd ?? process.cwd(), '.tmp', 'pdf-print-dialog', platformArch, 'bin', 'pdf-print-dialog');
}
