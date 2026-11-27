import {randomBytes} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import type {Stats} from 'node:fs';
import {chmod, lstat, mkdir, open, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';

const TOKEN_DIRECTORY_NAME = 'agent-mcp';
const TOKEN_FILE_NAME = 'bearer-token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_TOKEN_FILE_BYTES = 128;
const MAX_PATH_IDENTITY_RETRIES = 3;

function isMissingPathError(error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isExistingPathError(error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function usesPosixPermissions() {
    return process.platform !== 'win32' && typeof process.getuid === 'function';
}

function assertOwnedByCurrentUser(stats: Stats, description: string) {
    if (usesPosixPermissions() && stats.uid !== process.getuid!()) {
        throw new Error(`${description} is not owned by the current user.`);
    }
}

function pathsHaveSameIdentity(left: Stats, right: Stats) {
    return left.dev === right.dev && left.ino === right.ino;
}

async function ensurePrivateTokenDirectory(directoryPath: string) {
    await mkdir(directoryPath, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
    });
    const stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error('The local MCP token directory must be a regular directory, not a link or special file.');
    }
    assertOwnedByCurrentUser(stats, 'The local MCP token directory');
    if (usesPosixPermissions() && (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
    }
    return lstat(directoryPath);
}

function assertSafeTokenFile(stats: Stats) {
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('The local MCP token must be a regular file, not a link or special file.');
    }
    assertOwnedByCurrentUser(stats, 'The local MCP token file');
}

function hasPrivateTokenMode(stats: Stats) {
    return !usesPosixPermissions() || (stats.mode & 0o777) === PRIVATE_FILE_MODE;
}

function getReadFlags() {
    return process.platform === 'win32' ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
}

async function readTokenWithStableIdentity(tokenPath: string) {
    for (let attempt = 0; attempt < MAX_PATH_IDENTITY_RETRIES; attempt += 1) {
        let pathStats: Stats;
        try {
            pathStats = await lstat(tokenPath);
        } catch (error) {
            if (isMissingPathError(error)) {
                return {kind: 'missing'} as const;
            }
            throw error;
        }
        assertSafeTokenFile(pathStats);
        if (!hasPrivateTokenMode(pathStats)) {
            return {
                kind: 'rotate',
                stats: pathStats,
            } as const;
        }

        let handle;
        try {
            handle = await open(tokenPath, getReadFlags());
        } catch (error) {
            if (isMissingPathError(error)) {
                continue;
            }
            throw error;
        }
        try {
            const descriptorStats = await handle.stat();
            assertSafeTokenFile(descriptorStats);
            const currentPathStats = await lstat(tokenPath);
            if (!pathsHaveSameIdentity(pathStats, descriptorStats) || !pathsHaveSameIdentity(descriptorStats, currentPathStats)) {
                continue;
            }
            if (descriptorStats.size > MAX_TOKEN_FILE_BYTES) {
                return {
                    kind: 'rotate',
                    stats: descriptorStats,
                } as const;
            }
            const token = (await handle.readFile('utf8')).trim();
            return TOKEN_PATTERN.test(token)
                ? ({
                      kind: 'token',
                      token,
                  } as const)
                : ({
                      kind: 'rotate',
                      stats: descriptorStats,
                  } as const);
        } finally {
            await handle.close();
        }
    }
    throw new Error('The local MCP token changed repeatedly while it was being read.');
}

async function writeExclusiveToken(tokenPath: string, token: string) {
    const handle = await open(tokenPath, 'wx', PRIVATE_FILE_MODE);
    try {
        if (usesPosixPermissions()) {
            await handle.chmod(PRIVATE_FILE_MODE);
        }
        await handle.writeFile(`${token}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function replaceTokenAtomically(directoryPath: string, tokenPath: string, token: string, expectedStats: Stats) {
    const temporaryPath = join(directoryPath, `.bearer-token.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
    const backupPath = join(directoryPath, `.bearer-token.${process.pid}.${randomBytes(12).toString('hex')}.backup`);
    let hasBackup = false;
    try {
        await writeExclusiveToken(temporaryPath, token);
        const temporaryStats = await lstat(temporaryPath);
        assertSafeTokenFile(temporaryStats);
        const currentStats = await lstat(tokenPath);
        assertSafeTokenFile(currentStats);
        if (!pathsHaveSameIdentity(expectedStats, currentStats)) {
            throw new Error('The local MCP token changed while it was being rotated.');
        }
        if (process.platform === 'win32') {
            await rename(tokenPath, backupPath);
            hasBackup = true;
        }
        try {
            await rename(temporaryPath, tokenPath);
        } catch (error) {
            if (hasBackup) {
                await rename(backupPath, tokenPath).catch(() => undefined);
                hasBackup = false;
            }
            throw error;
        }
        if (hasBackup) {
            await rm(backupPath, {force: true});
            hasBackup = false;
        }
    } finally {
        await rm(temporaryPath, {force: true}).catch(() => {});
        if (hasBackup) {
            await rename(backupPath, tokenPath).catch(() => undefined);
        }
    }
}

export function getLocalMcpTokenStoragePaths(userDataPath: string) {
    const directoryPath = join(userDataPath, TOKEN_DIRECTORY_NAME);
    return {
        directoryPath,
        tokenPath: join(directoryPath, TOKEN_FILE_NAME),
    };
}

export async function ensureSecurePersistentLocalMcpToken(userDataPath: string) {
    const {directoryPath, tokenPath} = getLocalMcpTokenStoragePaths(userDataPath);
    const initialDirectoryStats = await ensurePrivateTokenDirectory(directoryPath);

    for (let attempt = 0; attempt < MAX_PATH_IDENTITY_RETRIES; attempt += 1) {
        const result = await readTokenWithStableIdentity(tokenPath);
        if (result.kind === 'token') {
            return result.token;
        }

        const token = randomBytes(32).toString('hex');
        if (result.kind === 'missing') {
            try {
                await writeExclusiveToken(tokenPath, token);
            } catch (error) {
                if (isExistingPathError(error)) {
                    continue;
                }
                throw error;
            }
        } else {
            await replaceTokenAtomically(directoryPath, tokenPath, token, result.stats);
        }

        const currentDirectoryStats = await ensurePrivateTokenDirectory(directoryPath);
        if (!pathsHaveSameIdentity(initialDirectoryStats, currentDirectoryStats)) {
            throw new Error('The local MCP token directory changed while the token was being created.');
        }
        const verified = await readTokenWithStableIdentity(tokenPath);
        if (verified.kind === 'token' && verified.token === token) {
            return token;
        }
    }

    throw new Error('Unable to create a stable local MCP token file.');
}
