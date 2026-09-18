import { execFile } from 'node:child_process';
import {createHash} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    copyFile,
    open,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isErrnoException } from '@contracts/runtimeGuards';

export interface IGuestFileStat {
    bytes: number;
    modifiedMs: number;
}

export interface IGuestFileSystem {
    exists(filePath: string): Promise<boolean>;
    readText(filePath: string): Promise<string>;
    readBytes(filePath: string): Promise<Uint8Array>;
    fingerprint?(filePath: string): Promise<{
        sha256: string;
        bytes: number
    }>;
    writeText(filePath: string, contents: string): Promise<void>;
    writeBytes(filePath: string, contents: Uint8Array): Promise<void>;
    copyFile(fromPath: string, toPath: string): Promise<void>;
    writeTextDurable(filePath: string, contents: string): Promise<void>;
    appendText(filePath: string, contents: string): Promise<void>;
    makeDirectory(directoryPath: string): Promise<void>;
    listNames(directoryPath: string): Promise<string[]>;
    listFilesRecursively(directoryPath: string): Promise<string[]>;
    rename(fromPath: string, toPath: string): Promise<void>;
    remove(targetPath: string): Promise<void>;
    stat(filePath: string): Promise<IGuestFileStat>;
}

export interface IGuestCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface IGuestCommandOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}

export interface IGuestCommandRunner {run(command: string, args: readonly string[], options?: IGuestCommandOptions): Promise<IGuestCommandResult>;}

export interface IGuestClock {
    now(): number;
    nowIso(): string;
    sleep(milliseconds: number): Promise<void>;
}

export function sha256Hex(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

export function sha256HexOfText(contents: string) {
    return createHash('sha256').update(contents, 'utf8').digest('hex');
}

export const nodeGuestClock: IGuestClock = {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    sleep: milliseconds => delay(milliseconds),
};

function directoryOf(filePath: string) {
    const separatorIndex = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
    return separatorIndex <= 0 ? '' : filePath.slice(0, separatorIndex);
}

export function createNodeGuestFileSystem(): IGuestFileSystem {
    const ensureParent = async (filePath: string) => {
        const parent = directoryOf(filePath);
        if (parent.length > 0) {
            await mkdir(parent, { recursive: true });
        }
    };

    const listFilesRecursively = async (directoryPath: string, prefix = ''): Promise<string[]> => {
        const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: unknown) => {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return [];
            }
            throw error;
        });
        const files: string[] = [];
        for (const entry of entries) {
            const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                files.push(...await listFilesRecursively(`${directoryPath}/${entry.name}`, relativePath));
            } else if (entry.isFile()) {
                files.push(relativePath);
            }
        }
        return files;
    };

    return {
        exists: filePath => stat(filePath).then(() => true, () => false),
        readText: filePath => readFile(filePath, 'utf8'),
        readBytes: async filePath => new Uint8Array(await readFile(filePath)),
        fingerprint: async filePath => {
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of createReadStream(filePath)) {
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                hash.update(data);
                bytes += data.length;
            }
            return {
                sha256: hash.digest('hex'),
                bytes,
            };
        },
        writeText: async (filePath, contents) => {
            await ensureParent(filePath);
            await writeFile(filePath, contents, 'utf8');
        },
        writeBytes: async (filePath, contents) => {
            await ensureParent(filePath);
            await writeFile(filePath, contents);
        },
        copyFile: async (fromPath, toPath) => {
            await ensureParent(toPath);
            await copyFile(fromPath, toPath);
        },
        writeTextDurable: async (filePath, contents) => {
            await ensureParent(filePath);
            const handle = await open(filePath, 'w');
            try {
                await handle.writeFile(contents, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
        },
        appendText: async (filePath, contents) => {
            await ensureParent(filePath);
            await writeFile(filePath, contents, {
                encoding: 'utf8',
                flag: 'a',
            });
        },
        makeDirectory: async directoryPath => {
            await mkdir(directoryPath, { recursive: true });
        },
        listNames: directoryPath => readdir(directoryPath).catch(() => []),
        listFilesRecursively: directoryPath => listFilesRecursively(directoryPath),
        rename: (fromPath, toPath) => rename(fromPath, toPath),
        remove: targetPath => rm(targetPath, {
            force: true,
            recursive: true,
        }),
        stat: async filePath => {
            const stats = await stat(filePath);
            return {
                bytes: stats.size,
                modifiedMs: stats.mtimeMs,
            };
        },
    };
}

export function createNodeGuestCommandRunner(): IGuestCommandRunner {
    return { run: (command, args, options = {}) => new Promise<IGuestCommandResult>((resolve) => {
        execFile(command, [...args], {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const exitCode = error === null
                ? 0
                : typeof error.code === 'number' ? error.code : 1;
            resolve({
                exitCode,
                stdout,
                stderr,
            });
        });
    }) };
}
