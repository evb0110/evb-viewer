import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    tempDir: '/tmp/electron-test',
    userDataDir: '/profiles/electron-test',
    existsSync: vi.fn<(path: string) => boolean>(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    realpathSync: vi.fn<(path: string) => string>(),
}));

function createStat(isSymlink: boolean) {
    return {isSymbolicLink: () => isSymlink};
}

vi.mock('electron', () => ({app: {getPath: (name: string) => {
    if (name === 'temp') {
        return mocks.tempDir;
    }
    if (name === 'userData') {
        return mocks.userDataDir;
    }
    throw new Error(`Unknown path name: ${name}`);
}}}));

vi.mock('os', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    tmpdir: () => mocks.tempDir,
}));

vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
}));

vi.mock('fs/promises', () => ({
    lstat: async (path: string) => mocks.lstatSync(path),
    realpath: async (path: string) => mocks.realpathSync(path),
}));

const {
    isAllowedReadPath,
    isAllowedWritePath,
    resetPathValidatorCachesForTests,
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} = await import('@electron/utils/pathValidator');

process.env.EVB_APP_TEMP_NAMESPACE = 'test-profile';

beforeEach(() => {
    resetPathValidatorCachesForTests();
    mocks.tempDir = '/tmp/electron-test';
    mocks.userDataDir = '/profiles/electron-test';
    mocks.existsSync.mockReset();
    mocks.lstatSync.mockReset();
    mocks.realpathSync.mockReset();

    mocks.existsSync.mockReturnValue(true);
    mocks.lstatSync.mockReturnValue(createStat(false));
    mocks.realpathSync.mockImplementation((path: string) => path);
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(() => {
    delete process.env.EVB_APP_TEMP_NAMESPACE;
});

describe('isAllowedWritePath', () => {
    it('allows a file inside the temp directory', () => {
        expect(isAllowedWritePath('/tmp/electron-test/evb-viewer-test-profile/output.pdf')).toBe(true);
    });

    it('accepts Windows native paths inside the temp directory', () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            return path;
        });

        expect(isAllowedWritePath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf'))
            .toBe(true);
    });

    it('rejects symlink targets', () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        expect(isAllowedWritePath('/tmp/electron-test/evb-viewer-test-profile/symlink-output.pdf')).toBe(false);
    });

    it('does not authorize the shared legacy or another profile temp namespace', () => {
        expect(isAllowedWritePath('/tmp/electron-test/evb-viewer/output.pdf')).toBe(false);
        expect(isAllowedWritePath('/tmp/electron-test/evb-viewer-another-profile/output.pdf')).toBe(false);
    });
});

describe('isAllowedReadPath', () => {
    it('allows a regular file inside the temp directory', () => {
        expect(isAllowedReadPath('/tmp/electron-test/evb-viewer-test-profile/document.pdf')).toBe(true);
    });

    it('accepts canonical temp directory paths', () => {
        mocks.tempDir = '/tmp/electron-test';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === '/tmp/electron-test/evb-viewer-test-profile') {
                return '/private/tmp/electron-test/evb-viewer-test-profile';
            }
            return path;
        });

        expect(isAllowedReadPath('/private/tmp/electron-test/evb-viewer-test-profile/document.pdf')).toBe(true);
    });

    it('accepts Windows native paths inside the temp directory', () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile';
            }
            return path;
        });

        expect(isAllowedReadPath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf'))
            .toBe(true);
    });

    it('rejects symlink targets', () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        expect(isAllowedReadPath('/tmp/electron-test/evb-viewer-test-profile/symlink-document.pdf')).toBe(false);
    });

    it('rejects missing files', () => {
        mocks.existsSync.mockReturnValue(false);

        expect(isAllowedReadPath('/tmp/electron-test/evb-viewer-test-profile/missing.pdf')).toBe(false);
    });
});

describe('resolveAllowedReadPath', () => {
    it('rejects symlink targets', async () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        await expect(resolveAllowedReadPath('/tmp/electron-test/evb-viewer-test-profile/symlink.pdf')).resolves.toBeNull();
        expect(mocks.realpathSync).toHaveBeenCalledWith('/tmp/electron-test/evb-viewer-test-profile');
        expect(mocks.realpathSync).not.toHaveBeenCalledWith('/tmp/electron-test/evb-viewer-test-profile/symlink.pdf');
    });

    it('allows temp paths when canonical temp dir differs', async () => {
        mocks.tempDir = '/var/folders/abc/T';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === '/var/folders/abc/T/evb-viewer-test-profile') {
                return '/private/var/folders/abc/T/evb-viewer-test-profile';
            }
            if (path === '/var/folders/abc/T/evb-viewer-test-profile/file.pdf') {
                return '/private/var/folders/abc/T/evb-viewer-test-profile/file.pdf';
            }
            return path;
        });

        await expect(resolveAllowedReadPath('/var/folders/abc/T/evb-viewer-test-profile/file.pdf')).resolves.toBe('/private/var/folders/abc/T/evb-viewer-test-profile/file.pdf');
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
        await expect(resolveAllowedReadPath(`${configuredBase}\\pdf-work-1\\work.pdf`))
            .resolves.toBe(`${canonicalBase}\\pdf-work-1\\work.pdf`);
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

        await expect(resolveAllowedReadPath('C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf'))
            .resolves.toBe('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf');
    });
});

describe('resolveAllowedWritePath', () => {
    it('rejects symlink targets', async () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        await expect(resolveAllowedWritePath('/tmp/electron-test/evb-viewer-test-profile/symlink-write.pdf')).resolves.toBeNull();
        expect(mocks.realpathSync).toHaveBeenCalledWith('/tmp/electron-test/evb-viewer-test-profile');
        expect(mocks.realpathSync).not.toHaveBeenCalledWith('/tmp/electron-test/evb-viewer-test-profile/symlink-write.pdf');
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

        await expect(resolveAllowedWritePath('C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\new-output.pdf'))
            .resolves.toBe('C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\new-output.pdf');
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

        await expect(resolveAllowedWritePath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf'))
            .resolves.toBe('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\evb-viewer-test-profile\\pdf-work-1\\work.pdf');
    });
});
