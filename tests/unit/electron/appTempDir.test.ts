import {spawn} from 'node:child_process';
import {once} from 'node:events';
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
import {createServer} from 'node:net';
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
const {getOwnStartTime} = await import('@electron/utils/processIdentity');
const {registerManagedProcess} = await import('@electron/native-tools/managedProcessRegistry');

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

    it.runIf(process.platform !== 'win32')('replaces an owner-marker symlink without writing through to its target', async () => {
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
            // The owner is written once this process's start time is read.
            await getOwnStartTime();

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
            // The owner is written once this process's start time is read.
            const ownStartTime = await getOwnStartTime();
            expect(JSON.parse(readFileSync(join(
                getAppTempDirPath(),
                '.evb-app-temp-owner.json',
            ), 'utf8'))).toMatchObject({
                namespace: createAppTempNamespace('/profiles/current'),
                userDataPath: '/profiles/current',
                pid: process.pid,
                startTime: ownStartTime,
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
                // A live owner: this process, with its creation time.
                startTime: ownStartTime,
                startedAt: Date.now(),
            })}\n`);
            writeFileSync(join(recoveryPath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                namespace: createAppTempNamespace(recoveryUserDataPath),
                userDataPath: recoveryUserDataPath,
                pid: 4_194_306,
                startedAt: 0,
            })}\n`);
            writeFileSync(join(recoveryUserDataPath, 'workspace-checkpoint.json'), '{"checkpoint":true}\n');
            const recoveryCopies = [
                'readable',
                'unreadable',
            ].map(name => {
                const profile = join(tempRoot, name);
                const namespacePath = getAppTempDirPathForUserData(profile, tempRoot);
                const workingCopy = join(namespacePath, 'pdf-work-dirty', 'document.pdf');
                mkdirSync(join(namespacePath, 'pdf-work-dirty'), {recursive: true});
                mkdirSync(profile, {recursive: true});
                writeFileSync(workingCopy, 'accepted unsaved bytes');
                writeFileSync(join(profile, 'original.pdf'), 'last saved bytes');
                const records = join(profile, 'workspace-recovery');
                if (name === 'readable') {
                    mkdirSync(records);
                    writeFileSync(join(records, 'dirty.json'), JSON.stringify({
                        workingCopyRef: workingCopy,
                        isDirty: true,
                    }));
                } else {
                    // ENOTDIR is a real read failure on every host, unlike a missing directory.
                    writeFileSync(records, 'unavailable recovery directory');
                }
                writeFileSync(join(namespacePath, '.evb-app-temp-owner.json'), JSON.stringify({
                    namespace: createAppTempNamespace(profile),
                    userDataPath: profile,
                    pid: deadOwnerPid,
                    startedAt: 0,
                }));
                utimesSync(namespacePath, staleDate, staleDate);
                return {
                    profile,
                    workingCopy,
                };
            });
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

            const removed = await cleanupStaleAppTempNamespaces({maxAgeMs: 60_000});

            for (const {
                profile, workingCopy,
            } of recoveryCopies) {
                expect(existsSync(workingCopy), 'recovery-directory inspection cannot discard unsaved bytes').toBe(true);
                expect(readFileSync(workingCopy, 'utf8')).toBe('accepted unsaved bytes');
                expect(readFileSync(join(profile, 'original.pdf'), 'utf8')).toBe('last saved bytes');
            }
            expect(removed).toBe(1);

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
    it('reaps the native tools this profile\'s previous release recorded in its temp namespace', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-app-temp-reap-'));
        const deadOwner = spawn(process.execPath, [
            '-e',
            'process.exit(0);',
        ], {stdio: 'ignore'});
        const tool = spawn(process.execPath, [
            '-e',
            'setInterval(() => {}, 1000);',
        ], {
            detached: process.platform !== 'win32',
            stdio: 'ignore',
        });
        const toolSpawned = once(tool, 'spawn');
        try {
            await new Promise<void>(resolve => deadOwner.once('exit', () => resolve()));
            vi.stubEnv('EVB_APP_STATE_DIR', join(tempRoot, 'state'));
            vi.stubEnv('TMPDIR', tempRoot);
            vi.stubEnv('TEMP', tempRoot);
            vi.stubEnv('TMP', tempRoot);
            mocks.paths.userData = '/profiles/current';
            initializeAppTempNamespace('/profiles/current');
            // Releases before 2026-10 kept the namespace, and its native tools' records, in OS temp.
            const retiredPath = getRetiredAppTempDirPath();
            const scratchPath = await createManagedScratchTempDir('native-command-', retiredPath);
            writeFileSync(join(retiredPath, '.evb-app-temp-owner.json'), `${JSON.stringify({
                namespace: createAppTempNamespace('/profiles/current'),
                userDataPath: '/profiles/current',
                pid: deadOwner.pid,
                startedAt: 0,
            })}\n`);
            await toolSpawned;
            const registration = await registerManagedProcess(retiredPath, {
                pid: tool.pid!,
                hasExited: () => tool.exitCode !== null || tool.signalCode !== null,
                binaryPath: process.execPath,
                scratchPath,
            });
            // That release crashed: its run is gone and its tool still runs.
            const entry = JSON.parse(readFileSync(registration!.entryPath, 'utf8')) as Record<string, unknown>;
            writeFileSync(registration!.entryPath, JSON.stringify({
                ...entry,
                ownerPid: deadOwner.pid,
            }));
            const exited = once(tool, 'exit');

            await cleanupStaleAppTempNamespaces({maxAgeMs: 60_000});

            await exited;
            expect(existsSync(registration!.entryPath)).toBe(false);
            expect(existsSync(scratchPath)).toBe(false);
        } finally {
            if (tool.exitCode === null && tool.signalCode === null) tool.kill('SIGKILL');
            mocks.paths.userData = '/profiles/default';
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

    it('puts back the original a dead namespace\'s export replaced before removing it, and keeps one it cannot or whose owner runs', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-app-temp-export-'));
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        const outDir = join(tempRoot, 'out');
        const deadOwner = spawn(process.execPath, [
            '-e',
            'process.exit(0);',
        ], {stdio: 'ignore'});
        const unrelated = spawn(process.execPath, [
            '-e',
            'setInterval(() => {}, 1000);',
        ], {stdio: 'ignore'});
        const lock = createServer();
        // A socket path must fit sun_path (104 bytes on macOS), which a deep task temp root does not.
        const socketRoot = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'evb-sock-'));
        try {
            await new Promise<void>(resolve => deadOwner.once('exit', () => resolve()));
            vi.stubEnv('EVB_APP_STATE_DIR', join(tempRoot, 'state'));
            vi.stubEnv('TMPDIR', tempRoot);
            vi.stubEnv('TEMP', tempRoot);
            vi.stubEnv('TMP', tempRoot);
            mocks.paths.userData = '/profiles/current';
            initializeAppTempNamespace('/profiles/current');
            mkdirSync(outDir);
            const exportInto = async (profile: string, name: string, owner: Record<string, unknown> = {pid: deadOwner.pid}) => {
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
                    ...owner,
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
            // Its owner still runs; the clock puts its recorded start before the boot.
            const live = await exportInto('/profiles/live', 'page 333.png', {
                pid: process.pid,
                startTime: await getOwnStartTime(),
            });
            // An older version recorded no start time, and a live process now has
            // its pid: the profile's single-instance lock decides. A free one
            // ends the run; a held one (a listening SingletonSocket) keeps it.
            const olderEnded = await exportInto(join(tempRoot, 'older-ended'), 'page 4444.png', {pid: unrelated.pid});
            const heldProfile = join(tempRoot, 'older-held');
            const olderHeld = process.platform === 'win32' ? null : await exportInto(heldProfile, 'page 55555.png', {pid: unrelated.pid});
            if (olderHeld) {
                await new Promise<void>((resolve, reject) => lock.once('error', reject).listen(join(socketRoot, 'l'), resolve));
                mkdirSync(heldProfile, {recursive: true});
                symlinkSync(join(socketRoot, 'l'), join(heldProfile, 'SingletonSocket'));
            }

            await expect(cleanupStaleAppTempNamespaces({maxAgeMs: 60_000})).resolves.toBe(2);

            expect(readFileSync(settled.target, 'utf8')).toBe('original');
            expect(existsSync(settled.backup)).toBe(false);
            expect(existsSync(settled.namespacePath)).toBe(false);
            expect(readFileSync(unsettled.target, 'utf8')).toBe('exported');
            expect(existsSync(unsettled.namespacePath), 'its record still names a published file').toBe(true);
            expect(readFileSync(live.target, 'utf8')).toBe('exported');
            expect(existsSync(live.backup)).toBe(true);
            expect(readFileSync(olderEnded.target, 'utf8')).toBe('original');
            expect(existsSync(olderEnded.namespacePath)).toBe(false);
            if (olderHeld) {
                expect(readFileSync(olderHeld.target, 'utf8')).toBe('exported');
            }
        } finally {
            unrelated.kill('SIGKILL');
            lock.close();
            rmSync(socketRoot, {
                force: true,
                recursive: true,
            });
            mocks.paths.userData = '/profiles/default';
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
