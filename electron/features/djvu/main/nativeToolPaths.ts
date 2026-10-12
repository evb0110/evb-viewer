import { app } from 'electron';
import { existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import {
    copyFile,
    link,
    rename,
    symlink,
    unlink,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'path';
import { fileURLToPath } from 'url';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import { isErrnoException } from '@contracts/runtimeGuards';
import { getCommandDirectory } from '@electron/native-tools/toolRegistry';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    sweepStaleManagedScratchTempDirs,
    usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';
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

// ASCII is the common subset of every Windows ANSI code page. Aliasing all
// other characters also covers machines whose locale differs from the user's.
export function needsDjvuPathAlias(filePath: string, platform = process.platform) {
    return platform === 'win32' && (filePath.length >= WINDOWS_MAX_PATH || /[^\x20-\x7e]/u.test(filePath));
}

async function getDjvuScratchRoot() {
    const root = getAppTempDir();
    // Reserve enough room for mkdtemp's suffix and the longest alias below.
    const aliasSuffix = join('djvu-export-XXXXXX', 'output', `djvu-${'x'.repeat(36)}.tmp`);
    if (!needsDjvuPathAlias(join(root, aliasSuffix))) {
        return root;
    }
    // Node hands this environment value to PowerShell as UTF-16. No user path
    // is interpolated into shell code, and a disabled 8.3 policy is harmless.
    const shortPath = await runNativeCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); '
        + '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:EVB_DJVU_SCRATCH_ROOT).ShortPath',
    ], {
        env: {EVB_DJVU_SCRATCH_ROOT: root},
        includeProcessEnv: true,
        windowsHide: true,
        timeoutMs: 15_000,
    }).then(result => result.stdout.trim(), () => '');
    if (shortPath && !needsDjvuPathAlias(join(shortPath, aliasSuffix))) {
        return shortPath;
    }
    // Windows Temp allows each user to create private directories even when
    // their profile and its temp root have no ASCII short name. Use the same
    // managed markers, native-termination retention and stale sweep there.
    const systemTemp = join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp');
    if (needsDjvuPathAlias(join(systemTemp, aliasSuffix))) {
        throw new Error('No ASCII scratch root is available for Windows DjVuLibre');
    }
    await sweepStaleManagedScratchTempDirs(systemTemp);
    return systemTemp;
}

/**
 * Owns the ANSI filename boundary for all DjVuLibre commands. Windows inputs
 * use a folder junction when the filename is ASCII, or a hard link (a copy
 * only when linking is unavailable). Outputs use a junction to their managed
 * destination folder and are renamed after a proven successful tool exit.
 * Unproven native termination retains aliases under the managed scratch owner.
 */
export async function runDjvuSourceCommand(
    command: string,
    args: string[],
    sourceIndex: number,
    options: IRunCommandOptions = {},
) {
    const requestedSource = args[sourceIndex];
    if (process.platform !== 'win32' || requestedSource === undefined) {
        return runNativeCommand(command, args, options);
    }
    const sourcePath = resolve(requestedSource);
    // ddjvu's only other filename operand is its output, after the source.
    // djvused/djvudump have no output operand in any of our calls.
    const outputIndex = basename(command).toLowerCase().replace(/\.exe$/u, '') === 'ddjvu'
        ? sourceIndex + 1 : -1;
    const requestedOutput = args[outputIndex];
    const outputPath = requestedOutput === undefined ? undefined : resolve(requestedOutput);
    const commandDirectory = getCommandDirectory(command);
    const cwd = resolve(options.cwd ?? (options.defaultCwdToCommandDir ? commandDirectory : null) ?? process.cwd());
    // DjVuLibre also consults the ANSI working directory, even for absolute
    // operands. A non-ASCII installation/profile must use the ASCII scope.
    if (!needsDjvuPathAlias(sourcePath)
        && (outputPath === undefined || !needsDjvuPathAlias(outputPath))
        && !needsDjvuPathAlias(cwd)) {
        return runNativeCommand(command, args, options);
    }
    const scratchRoot = await getDjvuScratchRoot();
    return usingManagedScratchScope('djvu-export-', scratchRoot, async (scratchPath) => {
        const aliasArgs = [...args];
        aliasArgs[sourceIndex] = sourcePath;
        if (outputPath !== undefined) aliasArgs[outputIndex] = outputPath;
        const junctions: string[] = [];
        let outputAlias: string | undefined;
        const removeJunctions = () => Promise.all(junctions.map(alias => unlink(alias).catch((error: unknown) => {
            logger.warn(`Could not remove DjVu junction "${alias}": ${getErrorMessage(error)}`);
        })));
        try {
            if (needsDjvuPathAlias(sourcePath)) {
                const sourceFolderAlias = join(scratchPath, 'source');
                if (!needsDjvuPathAlias(join(sourceFolderAlias, basename(sourcePath)))) {
                    await symlink(dirname(resolve(sourcePath)), sourceFolderAlias, 'junction');
                    junctions.push(sourceFolderAlias);
                    aliasArgs[sourceIndex] = join(sourceFolderAlias, basename(sourcePath));
                } else {
                    const sourceAlias = join(scratchPath, 'input.djvu');
                    await link(sourcePath, sourceAlias).catch(async (error: unknown) => {
                        if (!isErrnoException(error) || ![
                            'EXDEV',
                            'EPERM',
                            'EACCES',
                            'ENOTSUP',
                            'EMLINK',
                        ].includes(String(error.code ?? ''))) {
                            throw error;
                        }
                        await copyFile(sourcePath, sourceAlias);
                    });
                    aliasArgs[sourceIndex] = sourceAlias;
                }
            }
            if (outputPath !== undefined && needsDjvuPathAlias(outputPath)) {
                const outputFolderAlias = join(scratchPath, 'output');
                await symlink(dirname(resolve(outputPath)), outputFolderAlias, 'junction');
                junctions.push(outputFolderAlias);
                // The temporary output stays on the destination volume, so the
                // Unicode rename does not copy even a multi-gigabyte result.
                outputAlias = join(outputFolderAlias, `djvu-${randomUUID()}.tmp`);
                aliasArgs[outputIndex] = outputAlias;
            }
            const result = await runNativeCommand(commandDirectory ? resolve(command) : command, aliasArgs, {
                ...options,
                cwd: scratchPath,
            });
            if (outputAlias !== undefined && outputPath !== undefined) {
                await rename(outputAlias, outputPath);
            }
            await removeJunctions();
            return result;
        } catch (error) {
            if (getUnprovenNativeTerminationDetail(error) === undefined) {
                if (outputAlias !== undefined) await unlink(outputAlias).catch(() => {});
                await removeJunctions();
            }
            throw error;
        }
    });
}
