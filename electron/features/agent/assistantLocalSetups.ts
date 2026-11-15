import {constants, existsSync} from 'fs';
import {access, readdir, stat} from 'fs/promises';
import {spawn} from 'child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename, delimiter, isAbsolute, join, resolve} from 'node:path';
import type {IAssistantInstanceConfig, TAssistantDriver} from '@contracts/assistant';
import {resolveCodexProcessLaunch} from '@electron/features/agent/codexProcessLaunch';
import {createDetachedChildProcessSpawnOptions, terminateDetachedChildProcess} from '@electron/utils/nativeChildProcess';

const VERSION_TIMEOUT_MS = 3_000;
const VERSION_OUTPUT_LIMIT = 4096;

export async function isAssistantExecutable(path: string) {
    try {
        if (!existsSync(path)) return false;
        await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

function executableNames(driver: TAssistantDriver) {
    return process.platform === 'win32' ? [`${driver}.exe`, `${driver}.cmd`, driver] : [driver];
}

export async function resolveInstalledAssistantExecutable(driver: TAssistantDriver, env: NodeJS.ProcessEnv = process.env) {
    const configured = driver === 'codex' ? env.CODEX_CLI_PATH : env.CLAUDE_CODE_PATH ?? env.CLAUDE_CLI_PATH;
    const home = env.HOME || env.USERPROFILE || homedir();
    const candidates = [
        ...(configured ? [configured] : []),
        ...(driver === 'codex' && process.platform === 'darwin' ? ['/Applications/Codex.app/Contents/Resources/codex'] : []),
        ...(env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir => executableNames(driver).map(name => join(dir, name))),
        ...executableNames(driver).map(name => join(home, '.local', 'bin', name)),
    ];
    for (const candidate of candidates) {
        if (await isAssistantExecutable(candidate)) return resolve(candidate);
    }
    if (process.platform !== 'win32') {
        const shell = env.SHELL || '/bin/zsh';
        if (!await isAssistantExecutable(shell)) return null;
        return new Promise<string | null>(resolveResult => {
            const child = spawn(shell, ['-lc', `command -v ${driver}`], createDetachedChildProcessSpawnOptions({env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true}));
            let output = '';
            let settled = false;
            const finish = (path: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(path); } };
            const timer = setTimeout(() => { finish(null); void terminateDetachedChildProcess(child, 1_000).catch(() => undefined); }, VERSION_TIMEOUT_MS);
            child.stdout?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(0, VERSION_OUTPUT_LIMIT); });
            child.stderr?.resume();
            child.on('error', () => finish(null));
            child.on('close', () => {
                const candidate = output.trim().split('\n')[0];
                if (!candidate) { finish(null); return; }
                void isAssistantExecutable(candidate).then(valid => finish(valid ? candidate : null));
            });
        });
    }
    return null;
}

/** Version checks never retain stdout/stderr or expose a launcher's environment. */
export function identifyAssistantExecutable(driver: TAssistantDriver, executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    return new Promise(resolveResult => {
        const launch = resolveCodexProcessLaunch(executable, ['--version']);
        const child = spawn(launch.command, launch.args, createDetachedChildProcessSpawnOptions({
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }));
        let output = '';
        let settled = false;
        const finish = (version: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveResult(version);
        };
        const timer = setTimeout(() => {
            finish(null); void terminateDetachedChildProcess(child, 1_000).catch(() => undefined);
        }, VERSION_TIMEOUT_MS);
        const collect = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(0, VERSION_OUTPUT_LIMIT); };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', () => finish(null));
        child.on('close', code => {
            const pattern = driver === 'codex' ? /\bcodex(?:-cli| CLI)?\s+(\d+\.\d+\.\d+)\b/iu : /\b(\d+\.\d+\.\d+)\s+\(Claude Code\)/u;
            finish(code === 0 ? pattern.exec(output)?.[1] ?? null : null);
        });
    });
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
            if (driver !== 'codex' && driver !== 'claude') continue;
            const path = resolve(directory, name);
            if (await isAssistantExecutable(path)) candidates.set(path, driver);
        }
    }
    const defaults = await Promise.all((['codex', 'claude'] as const).map(async driver => {
        const binaryPath = await resolveInstalledAssistantExecutable(driver, env);
        return {
            id: driver,
            driver,
            displayName: driver === 'codex' ? 'Codex' : 'Claude',
            enabled: true,
            homePath: join(env.HOME || env.USERPROFILE || homedir(), `.${driver}`),
            ...(binaryPath ? {binaryPath} : {}),
        };
    }));
    const identities = new Set(defaults.map(assistantSetupIdentity));
    const identified = await Promise.all([...candidates].map(async ([binaryPath, driver]) => {
        if (!await identifyAssistantExecutable(driver, binaryPath, env).catch(() => null)) return null;
        const name = basename(binaryPath).replace(/\.(?:exe|cmd|bat)$/iu, '');
        const homePath = name === driver ? join(env.HOME || env.USERPROFILE || homedir(), `.${driver}`) : undefined;
        const identity = assistantSetupIdentity({driver, binaryPath, homePath});
        if (identities.has(identity)) return null;
        identities.add(identity);
        return {
            id: `local-${driver}-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
            driver,
            displayName: name,
            enabled: true,
            binaryPath,
            ...(homePath ? {homePath} : {}),
        };
    }));
    return [...defaults, ...identified.filter(value => value !== null)];
}

/** Equal executable/home/argv identities collapse; distinct homes never do. */
export function assistantSetupIdentity(config: Pick<IAssistantInstanceConfig, 'driver' | 'binaryPath' | 'homePath' | 'shadowHomePath' | 'launchArgs' | 'environment'>) {
    const binary = config.binaryPath?.trim() || config.driver;
    const home = config.shadowHomePath?.trim() || config.homePath?.trim() || '';
    return JSON.stringify([
        isAbsolute(binary) ? resolve(binary) : binary,
        home,
        config.launchArgs ?? '',
        config.environment ?? [],
    ]);
}
