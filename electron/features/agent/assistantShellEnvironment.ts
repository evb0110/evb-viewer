import {spawn} from 'node:child_process';
import {userInfo} from 'node:os';
import {basename} from 'node:path';
import {createLogger} from '@electron/utils/createLogger';
import {createDetachedChildProcessSpawnOptions, terminateDetachedChildProcess} from '@electron/utils/nativeChildProcess';

const logger = createLogger('assistant-shell-environment');
const START = '__EVB_SHELL_ENV_START__';
const END = '__EVB_SHELL_ENV_END__';
const OUTPUT_LIMIT = 1024 * 1024;
let environment: Promise<NodeJS.ProcessEnv> | undefined;

/** Main owns one in-memory snapshot, shared by discovery, probes and chats. */
export function getAssistantShellEnvironment() {
    environment ??= readAssistantShellEnvironment(process.env);
    return environment;
}

/**
 * Adapted from T3 Code DesktopShellEnvironment.ts and packages/shared/src/shell.ts
 * (0b6f482dc5), MIT. Keep the interactive login shell, closed stdin and bounded
 * process lifetime. EVB captures exported variables in memory only, never caches
 * them on disk, and preserves an already inherited terminal environment.
 */
export async function readAssistantShellEnvironment(
    inherited: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
    timeoutMs = 5_000,
): Promise<NodeJS.ProcessEnv> {
    const baseline = {...inherited};
    if (platform === 'win32') {
        // Adapted from T3 Code shared/shell.ts setWindowsPath: copied records
        // lose process.env's case-insensitive lookup; keep one PATH spelling.
        for (const name of Object.keys(baseline)) {
            if (name !== 'PATH' && name.toUpperCase() === 'PATH') {
                baseline.PATH ??= baseline[name];
                delete baseline[name];
            }
        }
        return baseline;
    }
    if (baseline.TERM && baseline.TERM !== 'dumb') {return baseline;}
    let shell = baseline.SHELL;
    if (!shell) {
        try { shell = userInfo().shell ?? undefined; } catch { /* Use the platform login shell. */ }
    }
    shell ||= platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    // Clear DEBUG before the markers, as upstream does. NUL records preserve
    // exported multiline values and ignore banners outside the capture frame.
    const clearDebug = /^(?:bash|zsh|sh|ksh|ksh93)$/u.test(basename(shell))
        ? '(trap - DEBUG) 2>/dev/null && trap - DEBUG; ' : '';
    const command = `${clearDebug}printf '${START}\\0'; /usr/bin/env -0; printf '${END}\\0'`;
    return new Promise<NodeJS.ProcessEnv | null>(resolveResult => {
        const child = spawn(shell, ['-ilc', command], createDetachedChildProcessSpawnOptions({
            env: baseline, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        }));
        let output = Buffer.alloc(0);
        let settled = false;
        const finish = async (success: boolean) => {
            if (settled) {return;}
            settled = true;
            clearTimeout(timer);
            const stopped = await terminateDetachedChildProcess(child, 1_000).catch(() => false);
            const text = output.toString('utf8');
            const start = text.indexOf(`${START}\0`);
            const end = text.indexOf(`${END}\0`, start + START.length + 1);
            if (success && stopped && start >= 0 && end > start) {
                const captured: NodeJS.ProcessEnv = {};
                for (const record of text.slice(start + START.length + 1, end).split('\0')) {
                    const separator = record.indexOf('=');
                    if (separator > 0) {captured[record.slice(0, separator)] = record.slice(separator + 1);}
                }
                if (captured.PATH) {
                    resolveResult(captured);
                    return;
                }
            }
            // Never log errors, output, shell paths or environment values.
            resolveResult(null);
        };
        // A descendant can keep stdout open after the shell exits. Accept only
        // a complete frame and a successful shell exit, then stop the group.
        const acceptCompletedCapture = () => {
            if (child.exitCode === 0 && output.includes(Buffer.from(`${END}\0`))) {void finish(true);}
        };
        const timer = setTimeout(() => { void finish(false); }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
            if (settled) {return;}
            if (output.length + chunk.length > OUTPUT_LIMIT) { void finish(false); return; }
            output = Buffer.concat([output, chunk]);
            acceptCompletedCapture();
        });
        child.once('error', () => { void finish(false); });
        child.once('exit', code => {
            if (code !== 0) {void finish(false);}
            else {acceptCompletedCapture();}
        });
        child.once('close', code => { void finish(code === 0); });
    }).catch(() => null).then(captured => {
        if (!captured) {logger.warn('Login-shell environment discovery failed; using inherited environment.');}
        return captured ?? baseline;
    });
}
