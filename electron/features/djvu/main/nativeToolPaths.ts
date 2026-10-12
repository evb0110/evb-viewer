import { app } from 'electron';
import { existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import {
    copyFile,
    link,
    mkdir,
    open,
    readdir,
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

// Node hands this environment value to PowerShell as UTF-16, without shell
// interpolation. A disabled 8.3 policy simply leaves a path needing an alias.
async function getWindowsShortPath(filePath: string, kind: 'GetFile' | 'GetFolder') {
    return runNativeCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); '
        + `(New-Object -ComObject Scripting.FileSystemObject).${kind}($env:EVB_DJVU_SCRATCH_ROOT).ShortPath`,
    ], {
        env: {EVB_DJVU_SCRATCH_ROOT: filePath},
        includeProcessEnv: true,
        windowsHide: true,
        timeoutMs: 15_000,
    }).then(result => result.stdout.trim(), () => '');
}

async function getDjvuScratchRoot() {
    const root = getAppTempDir();
    // Reserve enough room for mkdtemp's suffix and the longest alias below.
    const aliasSuffix = join('djvu-export-XXXXXX', 'source', `input-${'x'.repeat(36)}.djvu`);
    if (!needsDjvuPathAlias(join(root, aliasSuffix))) {
        return root;
    }
    const shortPath = await getWindowsShortPath(root, 'GetFolder');
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
 * only across volumes). Indirect indexes keep their component folder, using
 * its short name or a linked view when the index must be renamed. Outputs use
 * a junction to their destination folder and are renamed after a proven
 * successful tool exit.
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
                // DIRM is the first chunk in FORM:DJVM; bit 7 distinguishes
                // bundled from indirect. Read only its unencoded header,
                // leaving directory decoding and component names to DjVuLibre.
                const file = await open(sourcePath, 'r');
                const header = Buffer.alloc(25);
                try {
                    await file.read(header, 0, header.length, 0);
                } finally {
                    await file.close();
                }
                const indirect = header.toString('ascii', 12, 20) === 'DJVMDIRM' && (header[24]! & 0x80) === 0;
                const shortSource = indirect && needsDjvuPathAlias(basename(sourcePath))
                    ? await getWindowsShortPath(sourcePath, 'GetFile') : '';
                const sourceName = basename(shortSource || sourcePath);
                if (!needsDjvuPathAlias(join(sourceFolderAlias, sourceName))) {
                    // One junction serves even thousands of components, including
                    // an index with an ASCII short filename on an 8.3 volume.
                    await symlink(dirname(sourcePath), sourceFolderAlias, 'junction');
                    junctions.push(sourceFolderAlias);
                    aliasArgs[sourceIndex] = join(sourceFolderAlias, sourceName);
                } else {
                    const linkFile = async (source: string, alias: string) => {
                        await link(source, alias).catch(async (error: unknown) => {
                            if (!isErrnoException(error) || error.code !== 'EXDEV') throw error;
                            await copyFile(source, alias);
                        });
                    };
                    await mkdir(sourceFolderAlias);
                    const sourceAlias = join(sourceFolderAlias, `input-${randomUUID()}.djvu`);
                    await linkFile(sourcePath, sourceAlias);
                    aliasArgs[sourceIndex] = sourceAlias;
                    if (indirect) {
                        // No short index name: preserve sibling names in a private
                        // directory view. Link files; junction directories so
                        // nested components need no recursive copying.
                        for (const entry of await readdir(dirname(sourcePath), {withFileTypes: true})) {
                            if (entry.name === basename(sourcePath)) continue;
                            const original = join(dirname(sourcePath), entry.name);
                            const alias = join(sourceFolderAlias, entry.name);
                            if (entry.isDirectory()) {
                                await symlink(original, alias, 'junction');
                                junctions.push(alias);
                            } else await linkFile(original, alias);
                        }
                    }
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
