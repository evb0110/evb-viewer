import {spawn} from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
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

const {
    cleanupStaleAppTempNamespaces,
    createAppTempNamespace,
    getAppTempDir,
    getAppTempDirPath,
    getAppTempDirPathForUserData,
    initializeAppTempNamespace,
} = await import('@electron/utils/appTempDir');

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

    it('propagates the profile namespace for worker-safe temp resolution', () => {
        vi.stubEnv('TMPDIR', '/tmp');
        const namespace = initializeAppTempNamespace('/profiles/automation-a');

        expect(process.env.EVB_APP_TEMP_NAMESPACE).toBe(namespace);
        expect(getAppTempDirPath()).toBe(`/tmp/evb-viewer-${namespace}`);
    });

    it('derives the temp namespace path outside Electron from a profile path', () => {
        const namespace = createAppTempNamespace('/profiles/automation-a');

        expect(getAppTempDirPathForUserData('/profiles/automation-a', '/var/tmp'))
            .toBe(`/var/tmp/evb-viewer-${namespace}`);
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
            vi.stubEnv('TMPDIR', tempRoot);
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
            vi.stubEnv('TMPDIR', tempRoot);
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
});
