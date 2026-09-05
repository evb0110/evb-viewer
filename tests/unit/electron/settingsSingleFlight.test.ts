import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import type * as Os from 'node:os';

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

const mocks = vi.hoisted(() => ({
    readFile: vi.fn(),
    userInfo: vi.fn(),
    userDataPath: '',
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        readFile: mocks.readFile,
    };
});
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof Os>();
    return {
        ...actual,
        userInfo: mocks.userInfo,
    };
});

describe('settings single-flight loading', () => {
    const paths: string[] = [];

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.userDataPath = await mkdtemp(join(tmpdir(), 'evb-settings-single-flight-'));
        paths.push(mocks.userDataPath);
        await writeFile(join(mocks.userDataPath, 'settings.json'), '{}');
        mocks.readFile.mockResolvedValue('{}');
        mocks.userInfo.mockReturnValue({username: 'electron-user'});
    });

    afterEach(async () => {
        await Promise.all(paths.splice(0).map(path => rm(path, {
            force: true,
            recursive: true,
        })));
    });

    it('shares one unresolved read and returns a distinct clone to every caller', async () => {
        const read = deferred<string>();
        mocks.readFile.mockReturnValue(read.promise);
        const {loadSettings} = await import('@electron/settings');

        const first = loadSettings();
        const second = loadSettings();
        expect(mocks.readFile).toHaveBeenCalledOnce();

        read.resolve(JSON.stringify({theme: 'dark'}));
        const [
            firstSettings,
            secondSettings,
        ] = await Promise.all([
            first,
            second,
        ]);

        expect(firstSettings).toMatchObject({theme: 'dark'});
        expect(secondSettings).toEqual(firstSettings);
        expect(secondSettings).not.toBe(firstSettings);
    });

    it('does not let an old generation repopulate the cache after a path reset', async () => {
        const oldRead = deferred<string>();
        const newRead = deferred<string>();
        mocks.readFile
            .mockReturnValueOnce(oldRead.promise)
            .mockReturnValueOnce(newRead.promise);
        const {
            loadSettings,
            resetSettingsCacheAfterUserDataPathChange,
        } = await import('@electron/settings');

        const oldLoad = loadSettings();
        const newPath = await mkdtemp(join(tmpdir(), 'evb-settings-single-flight-next-'));
        paths.push(newPath);
        await writeFile(join(newPath, 'settings.json'), '{}');
        mocks.userDataPath = newPath;
        resetSettingsCacheAfterUserDataPathChange();
        const newLoad = loadSettings();

        newRead.resolve(JSON.stringify({theme: 'light'}));
        oldRead.resolve(JSON.stringify({theme: 'dark'}));
        await expect(newLoad).resolves.toMatchObject({theme: 'light'});
        await expect(oldLoad).resolves.toMatchObject({theme: 'dark'});
        await expect(loadSettings()).resolves.toMatchObject({theme: 'light'});
        expect(mocks.readFile).toHaveBeenCalledTimes(2);
    });

    it('joins an active initial load before applying an update', async () => {
        const read = deferred<string>();
        mocks.readFile.mockReturnValue(read.promise);
        const {
            loadSettings,
            updateSettings,
        } = await import('@electron/settings');

        const initialLoad = loadSettings();
        const update = updateSettings(settings => ({
            ...settings,
            authorName: 'Joined update',
        }));
        read.resolve(JSON.stringify({theme: 'dark'}));

        await initialLoad;
        await expect(update).resolves.toMatchObject({
            authorName: 'Joined update',
            theme: 'dark',
        });
        expect(mocks.readFile).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'missing',
            {},
        ],
        [
            'empty',
            {authorName: ''},
        ],
    ])('uses the Electron OS username when authorName is %s', async (_label, payload) => {
        mocks.readFile.mockResolvedValue(JSON.stringify(payload));
        const {loadSettings} = await import('@electron/settings');

        await expect(loadSettings()).resolves.toMatchObject({authorName: 'electron-user'});
        expect(mocks.userInfo).toHaveBeenCalledOnce();
    });

    it('preserves an explicit authorName without consulting the OS username', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({authorName: 'Configured author'}));
        const {loadSettings} = await import('@electron/settings');

        await expect(loadSettings()).resolves.toMatchObject({authorName: 'Configured author'});
        expect(mocks.userInfo).not.toHaveBeenCalled();
    });

    it('fails closed when an existing settings file cannot be read', async () => {
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        const originalContent = JSON.stringify({
            theme: 'dark',
            authorName: 'Existing user',
        });
        await writeFile(settingsPath, originalContent);
        const readError = Object.assign(new Error('I/O failure'), {code: 'EIO'});
        mocks.readFile.mockRejectedValue(readError);
        const {updateSettings} = await import('@electron/settings');

        await expect(updateSettings(settings => ({
            ...settings,
            theme: 'light',
        }))).rejects.toBe(readError);
        expect(readFileSync(settingsPath, 'utf-8')).toBe(originalContent);
    });
});
