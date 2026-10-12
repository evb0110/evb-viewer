import {spawn} from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const paths: Record<string, string> = {userData: '/profiles/default'};
    return {paths};
});

vi.mock('electron', () => ({app: {getPath: (name: string) => mocks.paths[name]}}));

const {cleanupStaleAppTempNamespaces} = await import('@electron/utils/cleanupStaleAppTempNamespaces');
const {
    createAppTempNamespace,
    getAppTempDir,
    getAppTempDirPath,
    getAppTempDirPathForUserData,
    getRetiredAppTempDirPath,
    initializeAppTempNamespace,
} = await import('@electron/utils/appTempDir');
const {getAppStateDir} = await import('@node-runtime/appTempNamespace');
const {
    createManagedScratchTempDir,
    recordManagedScratchBackup,
    recordManagedScratchPublish,
} = await import('@electron/utils/managedScratchTemp');
const {readFileIdentity} = await import('@electron/utils/fileIdentity');

describe('app temp directory namespace', () => {
    afterEach(() => {
        delete process.env.EVB_APP_TEMP_NAMESPACE;
        vi.unstubAllEnvs();
    });

    it('derives a stable opaque namespace per userData profile', () => {
        const first = createAppTempNamespace('/profiles/first');

        expect(first).toBe(createAppTempNamespace('/profiles/first'));
        expect(first).not.toBe(createAppTempNamespace('/profiles/second'));
        expect(first).not.toContain('profiles');
    });

    it('propagates the profile namespace for worker-safe resolution, kept out of temp', () => {
        vi.stubEnv('EVB_APP_STATE_DIR', '/state');
        vi.stubEnv('TMPDIR', '/tmp');
        vi.stubEnv('TEMP', '/tmp');
        vi.stubEnv('TMP', '/tmp');
        const namespace = initializeAppTempNamespace('/profiles/automation-a');

        expect(process.env.EVB_APP_TEMP_NAMESPACE).toBe(namespace);
        expect(getAppTempDirPath()).toBe(join('/state', `evb-viewer-${namespace}`));
        expect(getRetiredAppTempDirPath()).toBe(join('/tmp', `evb-viewer-${namespace}`));
    });

    it('keeps app state in a per-user folder that survives a reboot and does not roam', () => {
        const env = {
            LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
            APPDATA: 'C:\\Users\\a\\AppData\\Roaming',
            TMPDIR: '/tmp',
            TEMP: 'C:\\Users\\a\\AppData\\Local\\Temp',
        };
        expect(getAppStateDir(env, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\evb-viewer-state');
        expect(getAppStateDir({}, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\evb-viewer-state');
        expect(getAppStateDir(env, 'darwin', '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'evb-viewer-state'));
        expect(getAppStateDir(env, 'linux', '/home/a')).toBe(join('/home/a', '.local', 'state', 'evb-viewer-state'));
        expect(getAppStateDir({XDG_STATE_HOME: '/data/state'}, 'linux', '/home/a')).toBe(join('/data/state', 'evb-viewer-state'));
        expect(getAppStateDir({XDG_STATE_HOME: 'relative'}, 'linux', '/home/a')).toBe(join('/home/a', '.local', 'state', 'evb-viewer-state'));
        // An automation profile never reaches the person's folder.
        expect(getAppStateDir({EVB_AUTOMATION_USER_DATA_DIR: '/task/user-data'}, 'linux', '/home/a')).toBe(join('/task/user-data', 'evb-viewer-state'));
        expect(getAppStateDir({EVB_AUTOMATION_USER_DATA_DIR: 'C:\\task\\user-data'}, 'win32', 'C:\\Users\\a')).toBe('C:\\task\\user-data\\evb-viewer-state');
        expect(getAppStateDir({
            EVB_APP_STATE_DIR: '/state',
            EVB_AUTOMATION_USER_DATA_DIR: '/task/user-data',
        }, 'linux', '/home/a')).toBe('/state');
    });

    it('derives the temp namespace path outside Electron from a profile path', () => {
        const namespace = createAppTempNamespace('/profiles/automation-a');

        expect(getAppTempDirPathForUserData('/profiles/automation-a', '/var/tmp'))
            .toBe(join('/var/tmp', `evb-viewer-${namespace}`));
    });

    it.runIf(process.platform !== 'win32')('replaces an owner-marker symlink without writing through to its target', () => {
        const previousUserDataPath = mocks.paths.userData ?? '/profiles/default';
        const previousNamespace = process.env.EVB_APP_TEMP_NAMESPACE;
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-app-temp-marker-'));
        const userDataPath = join(tempRoot, 'profile');
        const namespacePath = getAppTempDirPathForUserData(userDataPath, tempRoot);
        const markerPath = join(namespacePath, '.evb-app-temp-owner.json');
        const markerTarget = join(tempRoot, 'marker-target');

        try {
            vi.stubEnv('EVB_APP_STATE_DIR', tempRoot);
            mocks.paths.userData = userDataPath;
            initializeAppTempNamespace(userDataPath);
            mkdirSync(namespacePath, {recursive: true});
            writeFileSync(markerTarget, 'do not overwrite\n');
            symlinkSync(markerTarget, markerPath);

            getAppTempDir();

            expect(readFileSync(markerTarget, 'utf8')).toBe('do not overwrite\n');
            expect(lstatSync(markerPath).isSymbolicLink()).toBe(false);
        } finally {
            if (previousNamespace === undefined) {
                delete process.env.EVB_APP_TEMP_NAMESPACE;
            } else {
                process.env.EVB_APP_TEMP_NAMESPACE = previousNamespace;
            }
            mocks.paths.userData = previousUserDataPath;
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('removes only old namespaces with valid dead owners and keeps legacy data', async () => {
        const previousUserDataPath = mocks.paths.userData ?? '/profiles/default';
        const previousNamespace = process.env.EVB_APP_TEMP_NAMESPACE;
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-app-temp-cleanup-'));
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        const deadPath = getAppTempDirPathForUserData('/profiles/dead', tempRoot);
        const activePath = getAppTempDirPathForUserData('/profiles/active', tempRoot);
        const malformedPath = getAppTempDirPathForUserData('/profiles/malformed', tempRoot);
        const freshPath = getAppTempDirPathForUserData('/profiles/fresh', tempRoot);
        const recoveryUserDataPath = join(tempRoot, 'profile-with-checkpoint');
        const recoveryPath = getAppTempDirPathForUserData(recoveryUserDataPath, tempRoot);
        const legacyUserDataPath = join(tempRoot, 'legacy-profile');
        const legacyPath = getAppTempDirPathForUserData(legacyUserDataPath, tempRoot);
        const legacyOwner = spawn(process.execPath, [
            '-e',
            'setInterval(() => {}, 1000);',
            '--',
            `--user-data-dir=${legacyUserDataPath}`,
        ], {stdio: 'ignore'});
        const deadOwner = spawn(process.execPath, [
            '-e',
            'process.exit(0);',
        ], {stdio: 'ignore'});
        const deadOwnerPid = deadOwner.pid;

        try {
            expect(legacyOwner.pid).toBeGreaterThan(0);
            if (!deadOwnerPid) {
                throw new Error('dead owner process did not provide a PID');
            }
            await new Promise<void>((resolve, reject) => {
                deadOwner.once('error', reject);
                deadOwner.once('exit', () => resolve());
            });
            vi.stubEnv('EVB_APP_STATE_DIR', join(tempRoot, 'state'));
            vi.stubEnv('TMPDIR', tempRoot);
            vi.stubEnv('TEMP', tempRoot);
            vi.stubEnv('TMP', tempRoot);
            mocks.paths.userData = '/profiles/current';
            initializeAppTempNamespace('/profiles/current');
            getAppTempDir();
            expect(JSON.parse(readFileSync(join(
                getAppTempDirPath(),
                '.evb-app-temp-owner.json',
            ), 'utf8'))).toMatchObject({
                namespace: createAppTempNamespace('/profiles/current'),
                userDataPath: '/profiles/current',
                pid: process.pid,
            });

            mkdirSync(deadPath, {recursive: true});
            mkdirSync(activePath, {recursive: true});
            mkdirSync(join(legacyPath, 'pdf-work-live'), {recursive: true});
            mkdirSync(malformedPath, {recursive: true});
            mkdirSync(freshPath, {recursive: true});
            mkdirSync(recoveryPath, {recursive: true});
            mkdirSync(recoveryUserDataPath, {recursive: true});
            writeFileSync(join(deadPath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                namespace: createAppTempNamespace('/profiles/dead'),
                userDataPath: '/profiles/dead',
                pid: deadOwnerPid,
                startedAt: 0,
            })}\n`);
            writeFileSync(join(activePath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                namespace: createAppTempNamespace('/profiles/active'),
                userDataPath: '/profiles/active',
                pid: process.pid,
                startedAt: 0,
            })}\n`);
            writeFileSync(join(recoveryPath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                namespace: createAppTempNamespace(recoveryUserDataPath),
                userDataPath: recoveryUserDataPath,
                pid: 4_194_306,
                startedAt: 0,
            })}\n`);
            writeFileSync(join(recoveryUserDataPath, 'workspace-checkpoint.json'), '{"checkpoint":true}\n');
            writeFileSync(join(legacyPath, 'pdf-work-live', 'recent.pdf'), 'still in use');
            writeFileSync(join(malformedPath, '.evb-app-temp-owner.json'), '{"namespace":"broken","pid":"unknown"}\n');
            utimesSync(deadPath, staleDate, staleDate);
            utimesSync(activePath, staleDate, staleDate);
            utimesSync(legacyPath, staleDate, staleDate);
            utimesSync(malformedPath, staleDate, staleDate);
            utimesSync(recoveryPath, staleDate, staleDate);
            const recentNestedFile = join(legacyPath, 'pdf-work-live', 'recent.pdf');
            const recentDate = new Date();
            utimesSync(recentNestedFile, recentDate, recentDate);

            await expect(cleanupStaleAppTempNamespaces({maxAgeMs: 60_000})).resolves.toBe(1);

            expect(existsSync(deadPath)).toBe(false);
            expect(existsSync(activePath)).toBe(true);
            expect(existsSync(legacyPath)).toBe(true);
            expect(existsSync(recentNestedFile)).toBe(true);
            expect(existsSync(malformedPath)).toBe(true);
            expect(existsSync(freshPath)).toBe(true);
            expect(existsSync(recoveryPath), 'checkpointed recovery namespace is retained').toBe(true);
            expect(existsSync(join(recoveryUserDataPath, 'workspace-checkpoint.json'))).toBe(true);
            expect(legacyOwner.exitCode).toBeNull();
            expect(existsSync(getAppTempDirPath())).toBe(true);
        } finally {
            if (legacyOwner.exitCode === null) {
                await new Promise<void>((resolve) => {
                    legacyOwner.once('exit', () => resolve());
                    legacyOwner.kill('SIGKILL');
                });
            }
            if (deadOwner.exitCode === null) {
                deadOwner.kill('SIGKILL');
            }
            if (previousNamespace === undefined) {
                delete process.env.EVB_APP_TEMP_NAMESPACE;
            } else {
                process.env.EVB_APP_TEMP_NAMESPACE = previousNamespace;
            }
            mocks.paths.userData = previousUserDataPath;
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
    it('keeps a dead namespace whose save journal is not finished yet', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-app-temp-journal-'));
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        const deadOwner = spawn(process.execPath, [
            '-e',
            'process.exit(0);',
        ], {stdio: 'ignore'});
        try {
            await new Promise<void>(resolve => deadOwner.once('exit', () => resolve()));
            vi.stubEnv('EVB_APP_STATE_DIR', join(tempRoot, 'state'));
            vi.stubEnv('TMPDIR', tempRoot);
            vi.stubEnv('TEMP', tempRoot);
            vi.stubEnv('TMP', tempRoot);
            mocks.paths.userData = '/profiles/current';
            initializeAppTempNamespace('/profiles/current');
            const deadNamespace = (profile: string, journal: boolean) => {
                const namespacePath = getAppTempDirPathForUserData(profile, tempRoot);
                mkdirSync(join(namespacePath, 'pdf-work-held'), {recursive: true});
                writeFileSync(join(namespacePath, 'pdf-work-held', 'document.pdf'), 'saved');
                if (journal) {
                    // A save the antivirus held: its journal still names the original's backup.
                    writeFileSync(join(namespacePath, 'pdf-work-held', 'journal.json'), '{"version":1}\n');
                }
                writeFileSync(join(namespacePath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                    namespace: createAppTempNamespace(profile),
                    userDataPath: profile,
                    pid: deadOwner.pid,
                    startedAt: 0,
                })}\n`);
                utimesSync(namespacePath, staleDate, staleDate);
                return namespacePath;
            };
            const journaled = deadNamespace('/profiles/journaled', true);
            const finished = deadNamespace('/profiles/finished', false);

            await expect(cleanupStaleAppTempNamespaces({maxAgeMs: 60_000})).resolves.toBe(1);

            expect(existsSync(join(journaled, 'pdf-work-held', 'journal.json')), 'the working-copy sweep finishes it').toBe(true);
            expect(existsSync(finished)).toBe(false);
        } finally {
            mocks.paths.userData = '/profiles/default';
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('puts back the original a dead namespace\'s export replaced before removing it, and keeps one it cannot', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-app-temp-export-'));
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        const outDir = join(tempRoot, 'out');
        const deadOwner = spawn(process.execPath, [
            '-e',
            'process.exit(0);',
        ], {stdio: 'ignore'});
        try {
            await new Promise<void>(resolve => deadOwner.once('exit', () => resolve()));
            vi.stubEnv('EVB_APP_STATE_DIR', join(tempRoot, 'state'));
            vi.stubEnv('TMPDIR', tempRoot);
            vi.stubEnv('TEMP', tempRoot);
            vi.stubEnv('TMP', tempRoot);
            mocks.paths.userData = '/profiles/current';
            initializeAppTempNamespace('/profiles/current');
            mkdirSync(outDir);
            const exportInto = async (profile: string, name: string) => {
                const namespacePath = getAppTempDirPathForUserData(profile, tempRoot);
                const target = join(outDir, name);
                const backup = join(outDir, `.${name.length.toString(16).padStart(16, '0')}.tmp`);
                writeFileSync(target, 'original');
                const scratch = await createManagedScratchTempDir('pdfExport-', namespacePath);
                writeFileSync(join(scratch, '.evb-managed-scratch.json'), JSON.stringify({
                    createdAt: 0,
                    pid: deadOwner.pid,
                    prefix: 'pdfExport-',
                }));
                await recordManagedScratchBackup(scratch, backup, target, (await readFileIdentity(target))!);
                writeFileSync(backup, 'original');
                writeFileSync(join(outDir, 'staged'), 'exported');
                await recordManagedScratchPublish(scratch, target, (await readFileIdentity(join(outDir, 'staged')))!);
                renameSync(join(outDir, 'staged'), target);
                writeFileSync(join(namespacePath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                    namespace: createAppTempNamespace(profile),
                    userDataPath: profile,
                    pid: deadOwner.pid,
                    startedAt: 0,
                })}\n`);
                utimesSync(namespacePath, staleDate, staleDate);
                return {
                    namespacePath,
                    target,
                    backup,
                };
            };
            const settled = await exportInto('/profiles/settled', 'page 1.png');
            const unsettled = await exportInto('/profiles/unsettled', 'page 22.png');
            rmSync(unsettled.backup);

            await expect(cleanupStaleAppTempNamespaces({maxAgeMs: 60_000})).resolves.toBe(1);

            expect(readFileSync(settled.target, 'utf8')).toBe('original');
            expect(existsSync(settled.backup)).toBe(false);
            expect(existsSync(settled.namespacePath)).toBe(false);
            expect(readFileSync(unsettled.target, 'utf8')).toBe('exported');
            expect(existsSync(unsettled.namespacePath), 'its record still names a published file').toBe(true);
        } finally {
            mocks.paths.userData = '/profiles/default';
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
