import {afterEach, describe, expect, it} from 'vitest';
import {chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureSecurePersistentLocalMcpToken, getLocalMcpTokenStoragePaths} from '@electron/features/agent/localMcpTokenStore';

const temporaryRoots: string[] = [];

async function createUserDataPath() {
    const path = await mkdtemp(join(tmpdir(), 'evb-mcp-token-test-'));
    temporaryRoots.push(path);
    return path;
}

describe('local MCP token store', () => {
    afterEach(async () => {
        await Promise.all(
            temporaryRoots.splice(0).map((path) =>
                rm(path, {
                    recursive: true,
                    force: true,
                }),
            ),
        );
    });

    it('creates one stable token for concurrent callers in a private directory and file', async () => {
        const userDataPath = await createUserDataPath();

        const tokens = await Promise.all(Array.from({length: 16}, () => ensureSecurePersistentLocalMcpToken(userDataPath)));
        const paths = getLocalMcpTokenStoragePaths(userDataPath);

        expect(new Set(tokens).size).toBe(1);
        expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/u);
        expect((await readFile(paths.tokenPath, 'utf8')).trim()).toBe(tokens[0]);
        if (process.platform !== 'win32') {
            expect((await lstat(paths.directoryPath)).mode & 0o777).toBe(0o700);
            expect((await lstat(paths.tokenPath)).mode & 0o777).toBe(0o600);
        }
    });

    it('rotates an owned token with unsafe permissions instead of accepting it', async () => {
        const userDataPath = await createUserDataPath();
        const paths = getLocalMcpTokenStoragePaths(userDataPath);
        await mkdir(paths.directoryPath, {mode: 0o700});
        const unsafeToken = 'a'.repeat(64);
        await writeFile(paths.tokenPath, `${unsafeToken}\n`, {mode: 0o644});
        await chmod(paths.tokenPath, 0o644);

        const token = await ensureSecurePersistentLocalMcpToken(userDataPath);

        if (process.platform === 'win32') {
            expect(token).toBe(unsafeToken);
        } else {
            expect(token).not.toBe(unsafeToken);
            expect((await lstat(paths.tokenPath)).mode & 0o777).toBe(0o600);
        }
    });

    it('rotates oversized token files without reading an unbounded payload', async () => {
        const userDataPath = await createUserDataPath();
        const paths = getLocalMcpTokenStoragePaths(userDataPath);
        await mkdir(paths.directoryPath, {mode: 0o700});
        await writeFile(paths.tokenPath, 'c'.repeat(1024 * 1024), {mode: 0o600});

        const token = await ensureSecurePersistentLocalMcpToken(userDataPath);

        expect(token).toMatch(/^[0-9a-f]{64}$/u);
        expect((await lstat(paths.tokenPath)).size).toBeLessThanOrEqual(65);
    });

    it('rejects token symlinks without reading or modifying their target', async () => {
        const userDataPath = await createUserDataPath();
        const paths = getLocalMcpTokenStoragePaths(userDataPath);
        const targetPath = join(userDataPath, 'attacker-controlled');
        const targetContents = `${'b'.repeat(64)}\n`;
        await mkdir(paths.directoryPath, {mode: 0o700});
        await writeFile(targetPath, targetContents, 'utf8');
        await symlink(targetPath, paths.tokenPath);

        await expect(ensureSecurePersistentLocalMcpToken(userDataPath)).rejects.toThrow('regular file');
        expect(await readFile(targetPath, 'utf8')).toBe(targetContents);
    });

    it('rejects non-regular token paths', async () => {
        const userDataPath = await createUserDataPath();
        const paths = getLocalMcpTokenStoragePaths(userDataPath);
        await mkdir(paths.directoryPath, {mode: 0o700});
        await mkdir(paths.tokenPath);

        await expect(ensureSecurePersistentLocalMcpToken(userDataPath)).rejects.toThrow('regular file');
    });
});
