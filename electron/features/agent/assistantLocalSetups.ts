import electron from 'electron';
import {constants, existsSync} from 'fs';
import {access, readdir, realpath, stat} from 'fs/promises';
import {spawn} from 'child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {IAssistantInstanceConfig, TAssistantDriver} from '@contracts/assistant';
import {resolveCodexProcessLaunch} from '@electron/features/agent/codexProcessLaunch';
import {createDetachedChildProcessSpawnOptions, terminateDetachedChildProcess} from '@electron/utils/nativeChildProcess';

const VERSION_TIMEOUT_MS = 3_000;
const VERSION_OUTPUT_LIMIT = 4096;

/** Ignore the retired EVB-managed copy, including aliases into its directory. */
async function isRetiredManagedExecutable(path: string, env: NodeJS.ProcessEnv) {
    const home = env.HOME || env.USERPROFILE || homedir();
    const roots = [join(home, '.evb-viewer', 'codex', 'bin')];
    try {
        roots.push(join(electron.app.getPath('userData'), 'codex', 'bin'));
        roots.push(join(electron.app.getPath('appData'), 'EVB Viewer', 'codex', 'bin'));
    } catch {
        /* Standalone metadata callers may not have an Electron app. */
    }
    const candidate = await realpath(path).catch(() => resolve(path));
    for (const root of roots) {
        const managed = await realpath(root).catch(() => resolve(root));
        for (const [directory, executable] of [
            [resolve(root), resolve(path)],
            [managed, candidate],
        ]) {
            const child = relative(directory!, executable!);
            if (!child || (!child.startsWith('..') && !isAbsolute(child))) {
                return true;
            }
        }
    }
    return false;
}

export async function isAssistantExecutable(path: string) {
    try {
        if (!existsSync(path)) {
            return false;
        }
        await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

function executableNames(driver: TAssistantDriver) {
    return process.platform === 'win32' ? [`${driver}.exe`, `${driver}.cmd`, driver] : [driver];
}

/** The SDK can resolve the standard shim, but cannot preserve a named script's identity. */
export function isUnsupportedClaudeSdkWrapper(path: string, platform: NodeJS.Platform = process.platform) {
    return platform === 'win32' && /\.(?:cmd|bat|ps1)$/iu.test(path) && !/^claude\.(?:cmd|bat|ps1)$/iu.test(basename(path));
}

export async function resolveInstalledAssistantExecutable(driver: TAssistantDriver, env: NodeJS.ProcessEnv = process.env) {
    const configured = driver === 'codex' ? env.CODEX_CLI_PATH : (env.CLAUDE_CODE_PATH ?? env.CLAUDE_CLI_PATH);
    const home = env.HOME || env.USERPROFILE || homedir();
    const candidates = [
        ...(configured ? [configured] : []),
        ...(driver === 'codex' && process.platform === 'darwin' ? ['/Applications/Codex.app/Contents/Resources/codex'] : []),
        ...(env.PATH ?? '')
            .split(delimiter)
            .filter(Boolean)
            .flatMap((dir) => executableNames(driver).map((name) => join(dir, name))),
        ...executableNames(driver).map((name) => join(home, '.local', 'bin', name)),
    ];
    for (const candidate of candidates) {
        if (!(await isRetiredManagedExecutable(candidate, env)) && (await isAssistantExecutable(candidate))) {
            return resolve(candidate);
        }
    }
    return null;
}

/** Version checks never retain stdout/stderr or expose a launcher's environment. */
export function identifyAssistantExecutable(driver: TAssistantDriver, executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    return new Promise((resolveResult) => {
        const launch = resolveCodexProcessLaunch(executable, ['--version']);
        const child = spawn(
            launch.command,
            launch.args,
            createDetachedChildProcessSpawnOptions({
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            }),
        );
        let output = '';
        let settled = false;
        const finish = async (version: string | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            await terminateDetachedChildProcess(child, 1_000).catch(() => false);
            resolveResult(version);
        };
        const timer = setTimeout(() => {
            void finish(null);
        }, VERSION_TIMEOUT_MS);
        const collect = (chunk: Buffer) => {
            output = `${output}${chunk.toString()}`.slice(0, VERSION_OUTPUT_LIMIT);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', () => finish(null));
        child.on('close', (code) => {
            const pattern = driver === 'codex' ? /\bcodex(?:-cli| CLI)?\s+(\d+\.\d+\.\d+)\b/iu : /\b(\d+\.\d+\.\d+)\s+\(Claude Code\)/u;
            finish(code === 0 ? (pattern.exec(output)?.[1] ?? null) : null);
        });
    });
}

export function defaultAssistantLocalSetups(env: NodeJS.ProcessEnv = process.env): IAssistantInstanceConfig[] {
    return (['codex', 'claude'] as const).map((driver) => ({
        id: driver,
        driver,
        displayName: driver === 'codex' ? 'Codex' : 'Claude',
        enabled: true,
        homePath: join(env.HOME || env.USERPROFILE || homedir(), `.${driver}`),
    }));
}

/** The default setups as discovery reports them, without checking any other launcher. */
export function resolveDefaultAssistantSetups(env: NodeJS.ProcessEnv) {
    return Promise.all(
        defaultAssistantLocalSetups(env).map(async (config) => {
            const binaryPath = await resolveInstalledAssistantExecutable(config.driver, env);
            return {...config, ...(binaryPath ? {binaryPath} : {})};
        }),
    );
}

/**
 * EVB's independent launcher convention. No other application's settings or
 * credential files are read. A candidate's protocol probe remains owned by
 * assistantService; only a reported catalog makes its models selectable.
 */
export async function discoverAssistantLocalSetups(env: NodeJS.ProcessEnv = process.env): Promise<IAssistantInstanceConfig[]> {
    const candidates = new Map<string, TAssistantDriver>();
    for (const directory of new Set((env.PATH ?? '').split(delimiter).filter(Boolean))) {
        const names = await readdir(directory).catch(() => []);
        for (const name of names.sort()) {
            const stem = process.platform === 'win32' ? name.replace(/\.(?:exe|cmd|bat)$/iu, '') : name;
            const driver = /^(codex|claude)(?:-[a-z0-9][a-z0-9._-]*)?$/iu.exec(stem)?.[1]?.toLowerCase();
            if (driver !== 'codex' && driver !== 'claude') {
                continue;
            }
            const path = resolve(directory, name);
            if (driver === 'claude' && isUnsupportedClaudeSdkWrapper(path)) {
                continue;
            }
            if (!(await isRetiredManagedExecutable(path, env)) && (await isAssistantExecutable(path))) {
                candidates.set(path, driver);
            }
        }
    }
    const defaults = await resolveDefaultAssistantSetups(env);
    const identities = new Set(defaults.map(assistantSetupIdentity));
    const identified = await Promise.all(
        [...candidates].map(async ([binaryPath, driver]) => {
            if (!(await identifyAssistantExecutable(driver, binaryPath, env).catch(() => null))) {
                return null;
            }
            const name = basename(binaryPath).replace(/\.(?:exe|cmd|bat)$/iu, '');
            // Windows names are case-insensitive: `Codex.exe` is the plain `codex` launcher.
            const isPlain = name.toLowerCase() === driver;
            const homePath = isPlain ? join(env.HOME || env.USERPROFILE || homedir(), `.${driver}`) : undefined;
            const identity = assistantSetupIdentity({driver, binaryPath, homePath});
            if (identities.has(identity)) {
                return null;
            }
            identities.add(identity);
            return {
                id: `local-${driver}-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
                driver,
                // A second `codex` or `claude` differs from the default setup only by its folder.
                displayName: isPlain ? `${name} (${tildePath(dirname(binaryPath), env)})` : name,
                enabled: true,
                binaryPath,
                ...(homePath ? {homePath} : {}),
            };
        }),
    );
    return [...defaults, ...identified.filter((value) => value !== null)];
}

function tildePath(path: string, env: NodeJS.ProcessEnv) {
    const home = env.HOME || env.USERPROFILE || homedir();
    return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Equal executable/home/argv identities collapse; distinct homes never do. */
export function assistantSetupIdentity(
    config: Pick<IAssistantInstanceConfig, 'driver' | 'binaryPath' | 'homePath' | 'shadowHomePath' | 'launchArgs'>,
) {
    const binary = config.binaryPath?.trim() || config.driver;
    const home = config.shadowHomePath?.trim() || config.homePath?.trim() || '';
    return JSON.stringify([isAbsolute(binary) ? resolve(binary) : binary, home, config.launchArgs ?? '']);
}
