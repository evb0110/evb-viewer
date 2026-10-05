import { app } from 'electron';
import { existsSync } from 'fs';
import {
    symlink,
    unlink,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

export interface IDjvuNativeToolPaths {
    ddjvu: string;
    djvudump: string;
    djvused: string;
}

export interface IResolveDjvuNativeToolPathsOptions {
    exists?: (path: string) => boolean;
    isPackaged: boolean;
    nativeToolsBase: string;
    platform?: NodeJS.Platform;
    platformArch: string;
}

export interface IGetDjvuNativeToolsBaseOptions {
    cwd?: string;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    resourcesPath?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJVU_RESOURCE_NAME = 'djvulibre';
// DjVuLibre on Windows opens its source with the ANSI file API, which stops at
// MAX_PATH and does not accept the \\?\ form.
const WINDOWS_MAX_PATH = 260;
const SOURCE_FOLDER_ALIAS = 'source';
const logger = createLogger('djvu-native-tools');

function isElectronAppPackaged() {
    return app.isPackaged;
}
function getDjvuResourcesBaseCandidates(moduleDir: string, cwd = process.cwd()) {
    return [
        join(cwd, 'resources'),
        join(moduleDir, '..', '..', 'resources'),
        join(moduleDir, '..', '..', '..', 'resources'),
        join(moduleDir, '..', '..', '..', '..', 'resources'),
    ];
}

function hasExpectedDjvuResources(resourcesBase: string, pathExists: (path: string) => boolean) {
    return pathExists(join(resourcesBase, DJVU_RESOURCE_NAME));
}

function resolveDjvuResourcesBase(
    moduleDir: string,
    isPackaged: boolean,
    options: IGetDjvuNativeToolsBaseOptions,
) {
    if (isPackaged) {
        return options.resourcesPath ?? process.resourcesPath;
    }

    const pathExists = options.exists ?? existsSync;
    const candidates = getDjvuResourcesBaseCandidates(moduleDir, options.cwd);
    const resolved = candidates.find(candidate => hasExpectedDjvuResources(candidate, pathExists));
    return resolved ?? candidates[0]!;
}

function getDjvuToolBinaryPath(
    dir: string,
    name: string,
    isPackaged: boolean,
    options: {
        exists?: (path: string) => boolean;
        platform?: NodeJS.Platform;
    } = {},
) {
    const platform = options.platform ?? process.platform;
    const pathExists = options.exists ?? existsSync;
    const ext = platform === 'win32' ? '.exe' : '';
    const binPath = join(dir, 'bin', `${name}${ext}`);

    if (pathExists(binPath)) {
        return binPath;
    }

    if (isPackaged) {
        return binPath;
    }

    return name;
}

export function getDjvuNativeToolsBase(
    moduleDir: string = __dirname,
    isPackaged: boolean = isElectronAppPackaged(),
    options: IGetDjvuNativeToolsBaseOptions = {},
) {
    const resourcesBase = resolveDjvuResourcesBase(moduleDir, isPackaged, options);

    return resolveNativeToolsBase(moduleDir, isPackaged, {
        resourcesBase,
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
}

export function resolveDjvuNativeToolPaths(options: IResolveDjvuNativeToolPathsOptions): IDjvuNativeToolPaths {
    const djvuDir = join(options.nativeToolsBase, DJVU_RESOURCE_NAME, options.platformArch);
    const binaryPathOptions = {
        ...(options.exists !== undefined ? { exists: options.exists } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
    };

    return {
        ddjvu: getDjvuToolBinaryPath(djvuDir, 'ddjvu', options.isPackaged, binaryPathOptions),
        djvudump: getDjvuToolBinaryPath(djvuDir, 'djvudump', options.isPackaged, binaryPathOptions),
        djvused: getDjvuToolBinaryPath(djvuDir, 'djvused', options.isPackaged, binaryPathOptions),
    };
}

export function getDjvuNativeToolPaths(): IDjvuNativeToolPaths {
    const appIsPackaged = isElectronAppPackaged();
    return resolveDjvuNativeToolPaths({
        isPackaged: appIsPackaged,
        nativeToolsBase: getDjvuNativeToolsBase(__dirname, appIsPackaged),
        platformArch: resolvePlatformArchTag(),
    });
}

/**
 * Runs a DjVuLibre tool whose `args[sourceIndex]` is the DjVu source. A Windows
 * source path too long for DjVuLibre is passed through a junction to its folder
 * in a managed scratch directory that lives only for this command. A child
 * whose exit was not proven keeps the junction and scratch while this app runs;
 * the general stale sweep removes them a day after the app is gone, which
 * checks age and the app's PID, not the native tree.
 */
export async function runDjvuSourceCommand(
    command: string,
    args: string[],
    sourceIndex: number,
    options: IRunCommandOptions = {},
) {
    const sourcePath = args[sourceIndex];
    if (process.platform !== 'win32' || sourcePath === undefined || sourcePath.length < WINDOWS_MAX_PATH) {
        return runNativeCommand(command, args, options);
    }
    const scratchRoot = getAppTempDir();
    // mkdtemp appends six characters to the prefix.
    if (join(scratchRoot, 'djvu-export-XXXXXX', SOURCE_FOLDER_ALIAS, basename(sourcePath)).length >= WINDOWS_MAX_PATH) {
        throw new Error(`DjVu source path is too long for DjVuLibre: ${sourcePath}`);
    }
    return usingManagedScratchScope('djvu-export-', scratchRoot, async (scratchPath) => {
        const sourceFolderAlias = join(scratchPath, SOURCE_FOLDER_ALIAS);
        await symlink(dirname(sourcePath), sourceFolderAlias, 'junction');
        const aliasArgs = args.map((arg, index) => index === sourceIndex
            ? join(sourceFolderAlias, basename(sourcePath))
            : arg);
        // Unlinking removes only the junction, never the source folder's files.
        const removeAlias = () => unlink(sourceFolderAlias).catch((error: unknown) => {
            logger.warn(`Could not remove DjVu source junction "${sourceFolderAlias}": ${getErrorMessage(error)}`);
        });
        try {
            const result = await runNativeCommand(command, aliasArgs, options);
            await removeAlias();
            return result;
        } catch (error) {
            if (getUnprovenNativeTerminationDetail(error) === undefined) {
                await removeAlias();
            }
            throw error;
        }
    });
}
