import {
    constants,
    existsSync,
} from 'fs';
import {
    access,
    chmod,
    copyFile,
    lstat,
    mkdtemp,
    mkdir,
    open,
    rename,
    rm,
} from 'fs/promises';
import { spawn } from 'child_process';
import {
    delimiter,
    join,
    win32 as windowsPath,
} from 'path';
import {
    homedir,
    tmpdir,
} from 'os';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import { getErrorMessage } from '@electron/utils/error';
import { resolveCodexProcessLaunch } from '@electron/features/agent/codexProcessLaunch';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import { downloadPinnedCodexArtifact } from '@electron/features/agent/codexCliArtifactDownload';
import {
    PINNED_CODEX_CLI_VERSION,
    resolvePinnedCodexCliArtifact,
} from '@electron/features/agent/codexCliReleaseManifest';

export const CODEX_APP_INSTALL_URL = 'https://developers.openai.com/codex/app';
export const CODEX_STANDALONE_INSTALL_URL = resolvePinnedCodexCliArtifact()?.url
    ?? CODEX_APP_INSTALL_URL;
// Codex 0.150.1 keeps sampling after intermediate assistant/commentary chunks.
// Older app-server builds can stop the turn after a progress update.
const MIN_CODEX_APP_SERVER_VERSION = PINNED_CODEX_CLI_VERSION;

const CODEX_COMMAND_TIMEOUT_MS = 15_000;
const CODEX_INSTALL_TIMEOUT_MS = 5 * 60_000;
const SHELL_DETECTION_TIMEOUT_MS = 5_000;
const CODEX_COMMAND_MAX_OUTPUT_CHARS = 256 * 1024;

interface ICodexCliCommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

export interface ICodexCliInfo {
    installed: boolean;
    path: string | null;
    version: string | null;
    isVersionSupported: boolean;
    minimumVersion: string;
    managedInstallDir: string;
}

export interface IInstallCodexOptions {onProgress?: (message: string) => void;}

function getCodexExecutableName() {
    if (process.platform === 'win32') {
        return 'codex.cmd';
    }
    return 'codex';
}

function getWindowsCodexExecutableNames() {
    return [
        'codex.exe',
        'codex.cmd',
        'codex',
    ];
}

function getManagedCodexInstallDir() {
    try {
        return join(app.getPath('userData'), 'codex', 'bin');
    } catch {
        return join(homedir(), '.evb-viewer', 'codex', 'bin');
    }
}

function getManagedCodexPathCandidates() {
    const installDir = getManagedCodexInstallDir();
    if (process.platform === 'win32') {
        return getWindowsCodexExecutableNames().map(name => join(installDir, name));
    }
    return [join(installDir, getCodexExecutableName())];
}

function uniqueStrings(values: string[]) {
    return [...new Set(values.filter(value => value.trim().length > 0))];
}

function buildCodexPathCandidates() {
    const pathCandidates = (process.env.PATH ?? '')
        .split(delimiter)
        .flatMap(pathEntry => process.platform === 'win32'
            ? getWindowsCodexExecutableNames().map(name => join(pathEntry, name))
            : [join(pathEntry, getCodexExecutableName())]);

    const candidates = [
        process.env.CODEX_CLI_PATH,
        ...getManagedCodexPathCandidates(),
        process.platform === 'darwin'
            ? '/Applications/Codex.app/Contents/Resources/codex'
            : undefined,
        ...pathCandidates,
        join(homedir(), '.local', 'bin', getCodexExecutableName()),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/usr/bin/codex',
    ];
    return uniqueStrings(candidates.flatMap(candidate => typeof candidate === 'string' ? [candidate] : []));
}

async function isExecutable(path: string) {
    if (!existsSync(path)) {
        return false;
    }

    if (process.platform === 'win32') {
        return true;
    }

    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function runCommand(
    command: string,
    args: string[],
    timeoutMs = CODEX_COMMAND_TIMEOUT_MS,
    options: {
        env?: NodeJS.ProcessEnv;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
    } = {},
): Promise<ICodexCliCommandResult> {
    const appendBoundedOutput = (existing: string, chunk: string) => {
        if (existing.length >= CODEX_COMMAND_MAX_OUTPUT_CHARS) {
            return existing;
        }
        return `${existing}${chunk}`.slice(0, CODEX_COMMAND_MAX_OUTPUT_CHARS);
    };
    return new Promise((resolve) => {
        let launch: ReturnType<typeof resolveCodexProcessLaunch>;
        try {
            launch = resolveCodexProcessLaunch(command, args);
        } catch (error) {
            resolve({
                ok: false,
                stdout: '',
                stderr: getErrorMessage(error),
                exitCode: null,
            });
            return;
        }
        const child = spawn(launch.command, launch.args, createDetachedChildProcessSpawnOptions({
            env: {
                ...process.env,
                NO_COLOR: '1',
                ...options.env,
            },
            shell: launch.shell,
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
            windowsHide: true,
        }));
        const childStdout = child.stdout;
        const childStderr = child.stderr;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timingOut = false;
        const settleTimeout = (terminated: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: stderr || (terminated
                    ? 'Command timed out.'
                    : 'Command timed out and its process tree did not terminate.'),
                exitCode: null,
            });
        };
        const timeout = setTimeout(() => {
            if (settled || timingOut) {
                return;
            }
            timingOut = true;
            void terminateDetachedChildProcess(child, 1_000).then(
                settleTimeout,
                () => settleTimeout(false),
            );
        }, timeoutMs);

        childStdout.setEncoding('utf8');
        childStderr.setEncoding('utf8');
        childStdout.on('data', (chunk: string) => {
            stdout = appendBoundedOutput(stdout, chunk);
            options.onStdout?.(chunk);
        });
        childStderr.on('data', (chunk: string) => {
            stderr = appendBoundedOutput(stderr, chunk);
            options.onStderr?.(chunk);
        });
        child.on('error', (error) => {
            if (settled || timingOut) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: getErrorMessage(error),
                exitCode: null,
            });
        });
        child.on('close', (exitCode) => {
            if (settled || timingOut) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: exitCode === 0,
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}

async function findCodexInLoginShell() {
    if (process.platform === 'win32') {
        return null;
    }

    const shellPath = process.env.SHELL?.length ? process.env.SHELL : '/bin/zsh';
    if (!existsSync(shellPath)) {
        return null;
    }

    const result = await runCommand(shellPath, [
        '-lc',
        'command -v codex',
    ], SHELL_DETECTION_TIMEOUT_MS);
    const candidate = result.stdout.trim().split('\n')[0]?.trim();
    if (!candidate || !(await isExecutable(candidate))) {
        return null;
    }
    return candidate;
}

let codexCliPathPromise: Promise<string | null> | null = null;

export async function resolveCodexCliPath() {
    if (codexCliPathPromise) {
        return codexCliPathPromise;
    }

    const lookup = (async () => {
        for (const candidate of buildCodexPathCandidates()) {
            if (await isExecutable(candidate)) {
                return candidate;
            }
        }
        return findCodexInLoginShell();
    })();
    codexCliPathPromise = lookup;
    const resolvedPath = await lookup;
    if (resolvedPath === null) {
        codexCliPathPromise = null;
    }
    return resolvedPath;
}

export function runCodexCli(
    codexPath: string,
    args: string[],
    options: {env?: NodeJS.ProcessEnv} = {},
) {
    return runCommand(codexPath, args, CODEX_COMMAND_TIMEOUT_MS, options);
}

function parseCodexVersion(stdout: string) {
    const match = stdout.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/u);
    return match?.[1] ?? null;
}

function compareVersions(left: string, right: string) {
    const leftParts = left.split('.').map(part => Number.parseInt(part, 10));
    const rightParts = right.split('.').map(part => Number.parseInt(part, 10));
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const rawLeftPart = leftParts[index];
        const rawRightPart = rightParts[index];
        const leftPart = typeof rawLeftPart === 'number' && Number.isFinite(rawLeftPart) ? rawLeftPart : 0;
        const rightPart = typeof rawRightPart === 'number' && Number.isFinite(rawRightPart) ? rawRightPart : 0;
        if (leftPart !== rightPart) {
            return leftPart - rightPart;
        }
    }
    return 0;
}

function isCodexVersionSupported(version: string | null) {
    return version !== null && compareVersions(version, MIN_CODEX_APP_SERVER_VERSION) >= 0;
}

export async function getCodexCliInfo(): Promise<ICodexCliInfo> {
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        return {
            installed: false,
            path: null,
            version: null,
            isVersionSupported: false,
            minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
            managedInstallDir: getManagedCodexInstallDir(),
        };
    }

    const versionResult = await runCodexCli(codexPath, ['--version']);
    const version = versionResult.ok ? parseCodexVersion(versionResult.stdout || versionResult.stderr) : null;
    return {
        installed: true,
        path: codexPath,
        version,
        isVersionSupported: isCodexVersionSupported(version),
        minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
        managedInstallDir: getManagedCodexInstallDir(),
    };
}

function isMissingPathError(error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function resolveManagedCodexArchiveExtractorPath(
    platform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
    pathExists: (path: string) => boolean = existsSync,
) {
    const candidates = platform === 'win32'
        ? (() => {
            const configuredRoot = environment.SystemRoot;
            const normalizedConfiguredRoot = configuredRoot
                ? windowsPath.normalize(configuredRoot)
                : null;
            const normalizedRoot = normalizedConfiguredRoot
                && /^[a-z]:\\windows$/iu.test(normalizedConfiguredRoot)
                ? normalizedConfiguredRoot
                : 'C:\\Windows';
            return [windowsPath.join(normalizedRoot, 'System32', 'tar.exe')];
        })()
        : [
            '/usr/bin/tar',
            '/bin/tar',
        ];
    const extractorPath = candidates.find(pathExists);
    if (!extractorPath) {
        throw new Error('A trusted system tar extractor is required to install Codex.');
    }
    return extractorPath;
}

async function stageManagedCodexReplacement(stagedPath: string, targetPath: string) {
    const backupPath = `${targetPath}.backup.${process.pid}.${randomBytes(8).toString('hex')}`;
    let hasBackup = false;
    try {
        await rename(targetPath, backupPath);
        hasBackup = true;
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
    }
    try {
        await rename(stagedPath, targetPath);
    } catch (error) {
        if (hasBackup) {
            await rename(backupPath, targetPath).catch(() => undefined);
        }
        throw error;
    }
    return hasBackup ? backupPath : null;
}

async function restoreManagedCodexReplacement(targetPath: string, backupPath: string | null) {
    await rm(targetPath, {force: true});
    if (backupPath) {
        await rename(backupPath, targetPath);
    }
}

export async function removeReplacedCodexBackupBestEffort(
    backupPath: string | null,
    removeFile: (path: string, options: {force: true}) => Promise<unknown> = rm,
) {
    if (backupPath) {
        await removeFile(backupPath, {force: true}).catch(() => undefined);
    }
    return null;
}

let managedCodexInstallPromise: Promise<ICodexCliInfo> | null = null;

async function performManagedCodexInstall(options: IInstallCodexOptions) {
    const artifact = resolvePinnedCodexCliArtifact();
    if (!artifact) {
        throw new Error(`Managed Codex installation is not supported on ${process.platform}/${process.arch}.`);
    }
    const installDir = getManagedCodexInstallDir();
    await mkdir(installDir, {
        recursive: true,
        mode: 0o700,
    });
    if (process.platform !== 'win32') {
        await chmod(installDir, 0o700);
    }
    const workingDir = await mkdtemp(join(tmpdir(), 'evb-codex-install-'));
    const archivePath = join(workingDir, artifact.assetName);
    const extractionDir = join(workingDir, 'extracted');
    const targetPath = join(installDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    const stagedPath = join(installDir, `.codex.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let backupPath: string | null = null;
    try {
        options.onProgress?.(`Downloading verified Codex ${PINNED_CODEX_CLI_VERSION} artifact…`);
        await downloadPinnedCodexArtifact(artifact, archivePath);
        options.onProgress?.('SHA-256 verified. Extracting Codex…');
        await mkdir(extractionDir, {mode: 0o700});
        const extractionResult = await runCommand(
            resolveManagedCodexArchiveExtractorPath(),
            [
                artifact.archiveKind === 'tar.gz' ? '-xzf' : '-xf',
                archivePath,
                '-C',
                extractionDir,
                artifact.executableEntry,
            ],
            CODEX_INSTALL_TIMEOUT_MS,
        );
        if (!extractionResult.ok) {
            throw new Error(extractionResult.stderr.trim() || 'Failed to extract the verified Codex artifact.');
        }
        const extractedPath = join(extractionDir, artifact.executableEntry);
        const extractedStats = await lstat(extractedPath);
        if (extractedStats.isSymbolicLink() || !extractedStats.isFile()) {
            throw new Error('Verified Codex archive did not contain the expected regular executable file.');
        }
        await copyFile(extractedPath, stagedPath, constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') {
            await chmod(stagedPath, 0o700);
        }
        const stagedHandle = await open(stagedPath, 'r');
        try {
            await stagedHandle.sync();
        } finally {
            await stagedHandle.close();
        }

        backupPath = await stageManagedCodexReplacement(stagedPath, targetPath);
        const versionResult = await runCommand(targetPath, ['--version']);
        const version = versionResult.ok
            ? parseCodexVersion(versionResult.stdout || versionResult.stderr)
            : null;
        if (version !== PINNED_CODEX_CLI_VERSION) {
            await restoreManagedCodexReplacement(targetPath, backupPath);
            backupPath = null;
            throw new Error(`Installed Codex version ${version ?? 'unknown'} did not match pinned version ${PINNED_CODEX_CLI_VERSION}.`);
        }
        if (backupPath) {
            const replacedBackupPath = backupPath;
            backupPath = null;
            await removeReplacedCodexBackupBestEffort(replacedBackupPath);
        }
        options.onProgress?.(`Installed verified Codex ${version}.`);
        return {
            installed: true,
            path: targetPath,
            version,
            isVersionSupported: isCodexVersionSupported(version),
            minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
            managedInstallDir: installDir,
        };
    } catch (error) {
        if (backupPath) {
            try {
                await restoreManagedCodexReplacement(targetPath, backupPath);
                backupPath = null;
            } catch (restoreError) {
                throw new AggregateError(
                    [
                        error,
                        restoreError,
                    ],
                    `Codex installation failed and the previous executable remains at ${backupPath ?? '<unknown path>'}.`,
                );
            }
        }
        throw error;
    } finally {
        await rm(stagedPath, {force: true}).catch(() => undefined);
        await rm(workingDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export function installManagedCodex(options: IInstallCodexOptions = {}) {
    if (managedCodexInstallPromise) {
        return managedCodexInstallPromise;
    }
    const installPromise = performManagedCodexInstall(options).finally(() => {
        if (managedCodexInstallPromise === installPromise) {
            managedCodexInstallPromise = null;
        }
    });
    managedCodexInstallPromise = installPromise;
    return installPromise;
}
