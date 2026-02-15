import { createServer as createNetServer } from 'node:net';
import { execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const projectRoot = join(__dirname, '..', '..');

export const NUXT_PORT = 3235;
export const SESSION_WAIT_TIMEOUT_MS = 60_000;
export const COMMAND_REQUEST_TIMEOUT_MS = 120_000;
export const OPEN_PDF_READY_TIMEOUT_MS = 120_000;
export const OPEN_PDF_TRIGGER_TIMEOUT_MS = 12_000;
export const COMMAND_EXECUTION_TIMEOUT_MS = 180_000;

let currentSessionName = 'default';

export function getCurrentSessionName() {
    return currentSessionName;
}

export function setCurrentSessionName(name: string) {
    currentSessionName = name;
}

export const sessionsBaseDir = join(projectRoot, '.devkit', 'sessions');

export function sessionDir(name = getCurrentSessionName()) {
    return join(sessionsBaseDir, name);
}

export function sessionFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.json');
}

export function sessionStartingFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session-starting.json');
}

export function sessionLogFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.log');
}

export function electronUserDataPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'electron-user-data');
}

export function screenshotDirPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'screenshots');
}

export interface ISessionState {
    browser: Browser;
    page: Page;
    electronProcess: ChildProcess;
    nuxtProcess: ChildProcess | null;
    consoleMessages: Array<{ type: string; text: string; timestamp: number }>;
}

export interface ISessionInfo {
    port: number;
    pid: number;
    cdpPort: number;
    electronPid: number | null;
    nuxtPid: number | null;
}

export interface ISessionStartingInfo {
    pid: number;
    startedAt: number;
}

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                reject(new Error('Failed to allocate free port'));
                return;
            }
            const { port } = addr;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

export async function getPidsOnPort(port: number): Promise<number[]> {
    try {
        const output = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' }) as string;
        return output
            .split('\n')
            .map(entry => Number(entry.trim()))
            .filter(pid => Number.isFinite(pid) && pid > 0);
    } catch {
        return [];
    }
}

export async function killPids(
    pids: number[],
    options: {
        signal?: NodeJS.Signals | number;
        exclude?: Set<number>;
    } = {},
): Promise<void> {
    if (!Array.isArray(pids) || pids.length === 0) {
        return;
    }
    const signal = options.signal ?? 'SIGKILL';
    const exclude = options.exclude ?? new Set<number>();
    exclude.add(process.pid);
    if (typeof process.ppid === 'number' && process.ppid > 0) {
        exclude.add(process.ppid);
    }

    const uniquePids = Array.from(new Set(pids));
    for (const pid of uniquePids) {
        if (exclude.has(pid)) {
            continue;
        }
        try {
            process.kill(pid, signal);
        } catch {}
    }
}

export function getSessionInfo(name = getCurrentSessionName()): ISessionInfo | null {
    try {
        return JSON.parse(readFileSync(sessionFilePath(name), 'utf8'));
    } catch {
        return null;
    }
}

export function getSessionStartingInfo(name = getCurrentSessionName()): ISessionStartingInfo | null {
    try {
        return JSON.parse(readFileSync(sessionStartingFilePath(name), 'utf8')) as ISessionStartingInfo;
    } catch {
        return null;
    }
}

export function isProcessAlive(pid: number) {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function readSessionLogTail(maxLines = 80) {
    try {
        const text = readFileSync(sessionLogFilePath(), 'utf8');
        const lines = text.split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
    } catch {
        return '';
    }
}

export function markSessionStarting(pid: number) {
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(sessionStartingFilePath(), JSON.stringify({
        pid,
        startedAt: Date.now(),
    }));
}

export function clearSessionStarting(name = getCurrentSessionName()) {
    try {
        unlinkSync(sessionStartingFilePath(name));
    } catch {}
}

export function isSessionStarting(name = getCurrentSessionName()) {
    const info = getSessionStartingInfo(name);
    if (!info) {
        return false;
    }
    const startupAge = Date.now() - info.startedAt;
    if (startupAge > 5 * 60_000 || !isProcessAlive(info.pid)) {
        clearSessionStarting(name);
        return false;
    }
    return true;
}

export async function cleanupStaleSessionArtifacts(name = getCurrentSessionName()) {
    const info = getSessionInfo(name);
    if (info && !isProcessAlive(info.pid)) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }

    const starting = getSessionStartingInfo(name);
    if (starting && !isProcessAlive(starting.pid)) {
        clearSessionStarting(name);
    }

    if (info && !(await isSessionRunning(name)) && !isProcessAlive(info.pid)) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }
}

export async function isSessionRunning(name = getCurrentSessionName()): Promise<boolean> {
    const info = getSessionInfo(name);
    if (!info) {
        return false;
    }

    try {
        const res = await fetch(`http://localhost:${info.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'ping', args: [] }),
        });
        return res.ok;
    } catch {
        if (!isProcessAlive(info.pid)) {
            try {
                unlinkSync(sessionFilePath(name));
            } catch {}
        }
        return false;
    }
}

export function listAllSessionNames(): string[] {
    try {
        return readdirSync(sessionsBaseDir).filter(name => {
            try {
                return existsSync(sessionFilePath(name)) || existsSync(sessionStartingFilePath(name));
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

export async function listRunningSessions(): Promise<string[]> {
    const all = listAllSessionNames();
    const running: string[] = [];
    for (const name of all) {
        const info = getSessionInfo(name);
        if (info && isProcessAlive(info.pid)) {
            running.push(name);
        }
    }
    return running;
}
