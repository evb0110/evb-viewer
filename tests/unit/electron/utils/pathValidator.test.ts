import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resolve} from 'node:path';

const mocks = vi.hoisted(() => ({
    tempDir: '/tmp/electron-test',
    userDataDir: '/profiles/electron-test',
    existsSync: vi.fn<(path: string) => boolean>(),
    lstatSync: vi.fn<(path: string) => {isSymbolicLink: () => boolean}>(),
    realpathSync: vi.fn<(path: string) => string>(),
    statSync: vi.fn<(path: string, options?: unknown) => unknown>(),
}));

function createStat(isSymlink: boolean) {
    return {isSymbolicLink: () => isSymlink};
}

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => {
            if (name === 'temp') {
                return mocks.tempDir;
            }
            if (name === 'userData') {
                return mocks.userDataDir;
            }
            throw new Error(`Unknown path name: ${name}`);
        },
    },
}));

vi.mock('os', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    tmpdir: () => mocks.tempDir,
}));

vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
    statSync: (path: string, options?: unknown) => mocks.statSync(path, options),
}));

vi.mock('fs/promises', () => ({
    lstat: async (path: string) => mocks.lstatSync(path),
    realpath: async (path: string) => mocks.realpathSync(path),
}));

const {
    isAllowedReadPath,
    isAllowedWritePath,
    isReservedTempPath,
    resetPathValidatorCachesForTests,
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} = await import('@electron/utils/pathValidator');

process.env.EVB_APP_TEMP_NAMESPACE = 'test-profile';

beforeEach(() => {
    resetPathValidatorCachesForTests();
    mocks.tempDir = resolve('/tmp/electron-test');
    mocks.userDataDir = resolve('/profiles/electron-test');
    mocks.existsSync.mockReset();
    mocks.lstatSync.mockReset();
    mocks.realpathSync.mockReset();
    mocks.statSync.mockReset();

    mocks.existsSync.mockReturnValue(true);
    mocks.lstatSync.mockReturnValue(createStat(false));
    mocks.realpathSync.mockImplementation((path: string) => path);
    mocks.statSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(() => {
    delete process.env.EVB_APP_TEMP_NAMESPACE;
});

describe('isAllowedWritePath', () => {
    it('allows a file inside the temp directory', () => {
        expect(isAllowedWritePath(resolve('/tmp/electron-test/evb-viewer-test-profile/output.pdf'))).toBe(true);
    });

    it('accepts Windows native paths inside the temp directory', () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            return path;
        });

        expect(isAllowedWritePath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf')).toBe(
            true,
        );
    });

    it('rejects symlink targets', () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        expect(isAllowedWritePath(resolve('/tmp/electron-test/evb-viewer-test-profile/symlink-output.pdf'))).toBe(false);
    });

    it('does not authorize the shared legacy or another profile temp namespace', () => {
        expect(isAllowedWritePath(resolve('/tmp/electron-test/evb-viewer/output.pdf'))).toBe(false);
        expect(isAllowedWritePath(resolve('/tmp/electron-test/evb-viewer-another-profile/output.pdf'))).toBe(false);
    });
});

describe('isAllowedReadPath', () => {
    it('allows a regular file inside the temp directory', () => {
        expect(isAllowedReadPath(resolve('/tmp/electron-test/evb-viewer-test-profile/document.pdf'))).toBe(true);
    });

    it('accepts canonical temp directory paths', () => {
        mocks.tempDir = resolve('/tmp/electron-test');
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === resolve('/tmp/electron-test/evb-viewer-test-profile')) {
                return resolve('/private/tmp/electron-test/evb-viewer-test-profile');
            }
            return path;
        });

        expect(isAllowedReadPath(resolve('/private/tmp/electron-test/evb-viewer-test-profile/document.pdf'))).toBe(true);
    });

    it('accepts Windows native paths inside the temp directory', () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            return path;
        });

        expect(isAllowedReadPath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf')).toBe(
            true,
        );
    });

    it('rejects symlink targets', () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        expect(isAllowedReadPath(resolve('/tmp/electron-test/evb-viewer-test-profile/symlink-document.pdf'))).toBe(false);
    });

    it('rejects missing files', () => {
        mocks.existsSync.mockReturnValue(false);

        expect(isAllowedReadPath(resolve('/tmp/electron-test/evb-viewer-test-profile/missing.pdf'))).toBe(false);
    });
});

describe('resolveAllowedReadPath', () => {
    it('rejects symlink targets', async () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        await expect(resolveAllowedReadPath(resolve('/tmp/electron-test/evb-viewer-test-profile/symlink.pdf'))).resolves.toBeNull();
        expect(mocks.realpathSync).toHaveBeenCalledWith(resolve('/tmp/electron-test/evb-viewer-test-profile'));
        expect(mocks.realpathSync).not.toHaveBeenCalledWith(resolve('/tmp/electron-test/evb-viewer-test-profile/symlink.pdf'));
    });

    it('allows temp paths when canonical temp dir differs', async () => {
        mocks.tempDir = resolve('/var/folders/abc/T');
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === resolve('/var/folders/abc/T/evb-viewer-test-profile')) {
                return resolve('/private/var/folders/abc/T/evb-viewer-test-profile');
            }
            if (path === resolve('/var/folders/abc/T/evb-viewer-test-profile/file.pdf')) {
                return resolve('/private/var/folders/abc/T/evb-viewer-test-profile/file.pdf');
            }
            return path;
        });

        await expect(resolveAllowedReadPath(resolve('/var/folders/abc/T/evb-viewer-test-profile/file.pdf'))).resolves.toBe(
            resolve('/private/var/folders/abc/T/evb-viewer-test-profile/file.pdf'),
        );
    });

    it('recovers when the temp directory becomes canonicalizable only after the first validation', async () => {
        // Windows 8.3 short names: the configured temp path and the canonical
        // one differ, and the app temp dir is created lazily, so the first
        // validation can run before realpath can resolve the base dir. That
        // transient state must not poison later validations (the regression
        // pinned here cached the uncanonicalized base dirs for the process
        // lifetime, rejecting every packaged file read on Windows).
        mocks.tempDir = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
        const configuredBase = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\evb-viewer-test-profile';
        const canonicalBase = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\evb-viewer-test-profile';
        let tempDirExists = false;
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path.toLowerCase().startsWith(configuredBase.toLowerCase())) {
                if (!tempDirExists) {
                    throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
                }
                return `${canonicalBase}${path.slice(configuredBase.length)}`;
            }
            return path;
        });

        // First validation before anything created the app temp dir: the
        // containment answer for the configured form is still correct.
        expect(isAllowedWritePath(`${configuredBase}\\early-log.txt`)).toBe(true);

        tempDirExists = true;
        await expect(resolveAllowedReadPath(`${configuredBase}\\pdf-work-1\\work.pdf`)).resolves.toBe(
            `${canonicalBase}\\pdf-work-1\\work.pdf`,
        );
    });

    it('allows Windows paths when realpath returns native namespaced paths', async () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf';
            }
            return path;
        });

        await expect(
            resolveAllowedReadPath('C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf'),
        ).resolves.toBe('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf');
    });
});

describe('resolveAllowedWritePath', () => {
    it('rejects symlink targets', async () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        await expect(resolveAllowedWritePath(resolve('/tmp/electron-test/evb-viewer-test-profile/symlink-write.pdf'))).resolves.toBeNull();
        expect(mocks.realpathSync).toHaveBeenCalledWith(resolve('/tmp/electron-test/evb-viewer-test-profile'));
        expect(mocks.realpathSync).not.toHaveBeenCalledWith(resolve('/tmp/electron-test/evb-viewer-test-profile/symlink-write.pdf'));
    });

    it('allows missing Windows targets whose real parent is the temp directory', async () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.lstatSync.mockImplementation((path: string) => {
            if (path.endsWith('\\new-output.pdf')) {
                throw new Error('missing');
            }
            return createStat(false);
        });
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1';
            }
            return path;
        });

        await expect(
            resolveAllowedWritePath('C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\new-output.pdf'),
        ).resolves.toBe('C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\new-output.pdf');
    });

    it('allows existing Windows native namespaced targets inside the temp directory', async () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf';
            }
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1';
            }
            return path;
        });

        await expect(
            resolveAllowedWritePath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf'),
        ).resolves.toBe('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf');
    });
});

describe('pinned document revisions', () => {
    const inRoot = (path: string) => resolve('/tmp/electron-test/evb-viewer-test-profile', path);

    it('refuses the pinned revisions folder to every generic read and write, by any spelling', async () => {
        const pinned = inRoot('pinned-revisions/0b7c1a.pdf');
        const alias = inRoot('alias.pdf');
        mocks.realpathSync.mockImplementation((path: string) => (path === alias ? pinned : path));

        expect(isAllowedReadPath(pinned)).toBe(false);
        expect(isAllowedWritePath(pinned)).toBe(false);
        expect(isAllowedWritePath(inRoot('pinned-revisions'))).toBe(false);
        await expect(resolveAllowedReadPath(pinned)).resolves.toBeNull();
        await expect(resolveAllowedReadPath(alias)).resolves.toBeNull();
        await expect(resolveAllowedWritePath(pinned)).resolves.toBeNull();
        await expect(resolveAllowedWritePath(inRoot('pinned-revisions/new.pdf'))).resolves.toBeNull();
        const sibling = inRoot('pinned-revisions-other/document.pdf');
        await expect(resolveAllowedReadPath(sibling)).resolves.toBe(sibling);
    });

    it('refuses case variants and same-identity directory aliases of the pinned revisions folder', async () => {
        const upperPinned = inRoot('PINNED-REVISIONS/0b7c1a.pdf');
        const upperNew = inRoot('PINNED-REVISIONS/new.pdf');
        const upperDir = inRoot('PINNED-REVISIONS');
        for (const candidate of [upperPinned, upperNew, upperDir]) {
            expect(isAllowedReadPath(candidate)).toBe(false);
            expect(isAllowedWritePath(candidate)).toBe(false);
            await expect(resolveAllowedReadPath(candidate)).resolves.toBeNull();
            await expect(resolveAllowedWritePath(candidate)).resolves.toBeNull();
        }

        const aliasDir = inRoot('alias-dir');
        const aliasFile = inRoot('alias-dir/0b7c1a.pdf');
        const siblingFile = inRoot('sibling-dir/0b7c1a.pdf');
        mocks.statSync.mockImplementation((target: string) => {
            if (target === inRoot('pinned-revisions') || target === aliasDir) {
                return {
                    dev: 1n,
                    ino: 42n,
                };
            }
            if (target === aliasFile) {
                return {
                    dev: 1n,
                    ino: 44n,
                };
            }
            if (target === inRoot('sibling-dir') || target === siblingFile) {
                return {
                    dev: 1n,
                    ino: 43n,
                };
            }
            throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
        });

        expect(isAllowedReadPath(aliasFile)).toBe(false);
        expect(isAllowedWritePath(aliasFile)).toBe(false);
        await expect(resolveAllowedReadPath(aliasFile)).resolves.toBeNull();
        await expect(resolveAllowedWritePath(aliasFile)).resolves.toBeNull();
        await expect(resolveAllowedReadPath(siblingFile)).resolves.toBe(siblingFile);
        await expect(resolveAllowedWritePath(siblingFile)).resolves.toBe(siblingFile);
    });

    it('reports isReservedTempPath true for direct paths, case variants, directory aliases, and outside symlinks into pinned-revisions', () => {
        const pinned = inRoot('pinned-revisions/0b7c1a.pdf');
        const upperPinned = inRoot('PINNED-REVISIONS/0b7c1a.pdf');
        const aliasDir = inRoot('alias-dir');
        const aliasFile = inRoot('alias-dir/0b7c1a.pdf');
        const outsideLink = resolve('/outside/opened-pin-link.pdf');
        const outsideAliasDir = resolve('/outside/pin-dir-link');
        const outsideAliasNew = resolve('/outside/pin-dir-link/new.pdf');
        const outsideNormal = resolve('/outside/normal.pdf');
        const sibling = inRoot('pinned-revisions-other/document.pdf');

        mocks.statSync.mockImplementation((target: string) => {
            if (target === inRoot('pinned-revisions') || target === aliasDir) {
                return {dev: 1n, ino: 42n};
            }
            if (target === aliasFile) {
                return {dev: 1n, ino: 44n};
            }
            throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
        });
        mocks.realpathSync.mockImplementation((target: string) => {
            if (target === outsideLink) {
                return pinned;
            }
            if (target === outsideAliasDir) {
                return inRoot('pinned-revisions');
            }
            return target;
        });

        expect(isReservedTempPath(pinned)).toBe(true);
        expect(isReservedTempPath(upperPinned)).toBe(true);
        expect(isReservedTempPath(inRoot('PINNED-REVISIONS'))).toBe(true);
        expect(isReservedTempPath(aliasFile)).toBe(true);
        expect(isReservedTempPath(outsideLink)).toBe(true);
        expect(isReservedTempPath(outsideAliasNew)).toBe(true);
        expect(isReservedTempPath(sibling)).toBe(false);
        expect(isReservedTempPath(outsideNormal)).toBe(false);
    });
});
