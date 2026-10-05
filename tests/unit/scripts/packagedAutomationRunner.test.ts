import {spawn} from 'node:child_process';
import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path, {
    join,
    resolve,
} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    isOutsideRoot,
    resolvePackagedSourceRoot,
} from '@scripts/release/runPackagedAutomation';

describe('packaged automation source root', () => {
    // The platform argument selects the payload layout; paths stay host-native.
    it('is the payload each installer actually ships', () => {
        expect(resolvePackagedSourceRoot('/Applications/EVB Viewer.app/Contents/MacOS/EVB Viewer', 'darwin'))
            .toBe(resolve('/Applications/EVB Viewer.app'));
        expect(resolvePackagedSourceRoot('/opt/EVB Viewer/evb-viewer', 'linux')).toBe(resolve('/opt/EVB Viewer'));
        expect(resolvePackagedSourceRoot('/install/EVB Viewer/EVB Viewer.exe', 'win32')).toBe(resolve('/install/EVB Viewer'));
    });

    it.runIf(process.platform === 'win32')('is the drive-qualified Windows install folder', () => {
        expect(resolvePackagedSourceRoot('C:\\Program Files\\EVB Viewer\\EVB Viewer.exe'))
            .toBe('C:\\Program Files\\EVB Viewer');
    });
});

describe('packaged automation work root containment', () => {
    it('accepts a work root on another Windows drive and rejects source descendants', () => {
        const source = 'C:\\Program Files\\EVB Viewer';
        expect(isOutsideRoot(source, 'D:\\work\\run', path.win32)).toBe(true);
        expect(isOutsideRoot(source, 'C:\\work\\run', path.win32)).toBe(true);
        expect(isOutsideRoot(source, 'C:\\Program Files\\EVB Viewer\\run', path.win32)).toBe(false);
        expect(isOutsideRoot(source, source, path.win32)).toBe(false);
        expect(isOutsideRoot('/opt/EVB Viewer', '/opt/EVB Viewer/run', path.posix)).toBe(false);
        expect(isOutsideRoot('/opt/EVB Viewer', '/opt/EVB Viewer-work', path.posix)).toBe(true);
    });
});

// The Windows helper receipt is 'live-root-tree' only when this result is true.
describe('process tree termination receipt', () => {
    it('reports termination for a live root and none once the root is gone', async () => {
        const child = spawn(process.execPath, [
            '-e',
            'setInterval(() => {}, 1000)',
        ], {stdio: 'ignore'});
        const pid = child.pid!;
        const exited = new Promise(resolveExit => child.once('exit', resolveExit));

        try {
            expect(await killProcessTree(pid, 300)).toBe(true);
            await exited;
            expect(isProcessAlive(pid)).toBe(false);
            expect(await killProcessTree(pid, 300)).toBe(false);
        } finally {
            // The test owns this child: end it even when an assertion or the kill failed.
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        }
    });
});

// The fixture is a shell script, so Windows lifecycle is not exercised here.
describe.skipIf(process.platform === 'win32')('packaged automation runner lifecycle', () => {
    const roots: string[] = [];
    const pids: number[] = [];
    afterEach(async () => {
        // Read ownership records even if the test failed before reaching its PID assertions.
        for (const root of roots) {
            const env = await readFile(join(root, 'run', 'user-data.env'), 'utf8').catch(() => '');
            const helper = await readFile(join(root, 'run', 'user-data.helper'), 'utf8').catch(() => '');
            for (const value of [
                env.split('\n')[3],
                helper,
            ]) {
                const pid = Number(value);
                if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
            }
        }
        for (const pid of pids.splice(0)) {
            await killProcessTree(pid, 300);
        }
        for (const root of roots.splice(0)) {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });

    async function launch(
        body: string,
        environment: NodeJS.ProcessEnv = {},
        workDirectoryOverride?: string,
        options: {
            mode?: number;
            script?: string;
            scriptArguments?: (root: string) => string[]
        } = {},
    ) {
        const root = await mkdtemp(join(tmpdir(), 'evb-runner-test-'));
        roots.push(root);
        // macOS launches a bundle; Linux launches the installed directory's
        // executable by its own name, as the .deb ships it.
        const app = join(root, 'Fixture.app');
        const executable = process.platform === 'darwin'
            ? join(app, 'Contents', 'MacOS', 'Fixture')
            : join(root, 'opt', 'EVB Viewer', 'evb-viewer');
        await mkdir(join(executable, '..'), {recursive: true});
        await writeFile(executable, '#!/bin/sh\n'
            + 'printf "%s\\n" "$EVB_AUTOMATION_HIDE_WINDOW" "$EVB_AUTOMATION_NO_FOCUS" "${ELECTRON_RUN_AS_NODE-unset}" "$$" "$EVB_FILE_LOG_DIR" > "$EVB_AUTOMATION_USER_DATA_DIR.env"\n'
            + body, {mode: options.mode ?? 0o755});
        if (process.platform === 'darwin') {
            await writeFile(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?>'
                + '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>');
        }
        const workDirectory = workDirectoryOverride ?? join(root, 'run');
        const child = spawn(process.execPath, [
            '--import',
            'tsx',
            resolve(options.script ?? 'scripts/release/runPackagedAutomation.ts'),
            '--executable',
            executable,
            ...options.scriptArguments?.(root) ?? [
                '--work-directory',
                workDirectory,
            ],
        ], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                EVB_AUTOMATION_HIDE_WINDOW: '0',
                ...environment,
            },
            stdio: 'pipe',
        });
        if (child.pid) pids.push(child.pid);
        let output = '';
        child.stdout.on('data', data => { output += String(data); });
        child.stderr.on('data', data => { output += String(data); });
        const exited = new Promise<number | null>((resolveExit, reject) => {
            child.once('error', reject);
            child.once('exit', resolveExit);
        });
        return {
            child,
            exited,
            workDirectory,
            output: () => output,
        };
    }

    it('preserves a child failure code and removes its copy without starting a GUI', async () => {
        const run = await launch('exit 7\n');
        expect(await run.exited).toBe(7);
        expect(run.output()).toContain('code=7 signal=null');
        expect((await readFile(join(run.workDirectory, 'user-data.env'), 'utf8')).split('\n').slice(0, 3))
            .toEqual([
                '1',
                '1',
                'unset',
            ]);
        expect((await readdir(run.workDirectory)).filter(name => name.startsWith('hidden-packaged-app-'))).toEqual([]);
    });

    it('selects an owned log directory when the caller inherits the shared default', async () => {
        const run = await launch('exit 0\n', {EVB_FILE_LOG_DIR: join(tmpdir(), 'electron-logs')});
        expect(await run.exited).toBe(0);
        const values = (await readFile(join(run.workDirectory, 'user-data.env'), 'utf8')).trim().split('\n');
        expect(values[4]).toBe(join(await realpath(run.workDirectory), 'electron-logs'));
        expect(values[4]).not.toBe(join(tmpdir(), 'electron-logs'));
    });

    it('ignores an inherited log directory outside the owned work directory', async () => {
        const sharedRoot = await mkdtemp(join(tmpdir(), 'evb-runner-shared-root-'));
        roots.push(sharedRoot);
        const sharedLogDirectory = join(sharedRoot, 'electron-logs');
        const sharedUserDataDirectory = join(sharedRoot, 'user-data');
        await mkdir(sharedLogDirectory);
        await mkdir(sharedUserDataDirectory);
        await writeFile(join(sharedLogDirectory, 'sentinel'), 'keep-log');
        await writeFile(join(sharedUserDataDirectory, 'sentinel'), 'keep-profile');
        const run = await launch('exit 0\n', {
            EVB_FILE_LOG_DIR: sharedLogDirectory,
            EVB_AUTOMATION_USER_DATA_DIR: sharedUserDataDirectory,
        });
        expect(await run.exited).toBe(0);
        const values = (await readFile(join(run.workDirectory, 'user-data.env'), 'utf8')).trim().split('\n');
        expect(values[4]).toBe(join(await realpath(run.workDirectory), 'electron-logs'));
        expect(values[4]).not.toBe(sharedLogDirectory);
        expect(await readFile(join(sharedLogDirectory, 'sentinel'), 'utf8')).toBe('keep-log');
        expect(await readFile(join(sharedUserDataDirectory, 'sentinel'), 'utf8')).toBe('keep-profile');
    });

    it('allocates independent roots for concurrent fixtures', async () => {
        const [
            first,
            second,
        ] = await Promise.all([
            launch('exit 0\n'),
            launch('exit 0\n'),
        ]);
        expect(first.workDirectory).not.toBe(second.workDirectory);
        expect(await first.exited).toBe(0);
        expect(await second.exited).toBe(0);
        const firstValues = (await readFile(join(first.workDirectory, 'user-data.env'), 'utf8')).trim().split('\n');
        const secondValues = (await readFile(join(second.workDirectory, 'user-data.env'), 'utf8')).trim().split('\n');
        expect(firstValues[4]).not.toBe(secondValues[4]);
    });

    it('rejects a second runner claiming an existing task root', async () => {
        const first = await launch('exit 0\n');
        expect(await first.exited).toBe(0);
        const second = await launch('exit 0\n', {}, first.workDirectory);
        expect(await second.exited).toBe(1);
        expect(second.output()).toContain('empty and unused');
    });

    it('leaves the winner\'s root intact when two runners race for one task root', async () => {
        const shared = join(await mkdtemp(join(tmpdir(), 'evb-runner-race-')), 'run');
        roots.push(join(shared, '..'));
        const runs = await Promise.all([
            launch('sleep 1\nexit 0\n', {}, shared),
            launch('sleep 1\nexit 0\n', {}, shared),
        ]);
        const codes = await Promise.all(runs.map(run => run.exited));
        expect([...codes].sort()).toEqual([
            0,
            1,
        ]);
        expect(runs[codes.indexOf(1)]!.output()).toMatch(/empty and unused|already claimed|EEXIST/u);
        expect((await readFile(join(shared, 'user-data.env'), 'utf8')).split('\n')[0]).toBe('1');
    });

    it('fails scan-cleanup startup for an unlaunchable payload and removes its copy', async () => {
        let artifactDirectory = '';
        const run = await launch('exit 0\n', {}, undefined, {
            mode: 0o644,
            script: 'scripts/release/verifyPackagedScanCleanup.ts',
            scriptArguments: (root) => {
                artifactDirectory = join(root, 'artifacts');
                writeFileSync(join(root, 'source.pdf'), 'source');
                return [
                    '--source',
                    join(root, 'source.pdf'),
                    '--artifact-dir',
                    artifactDirectory,
                    '--scale-only',
                ];
            },
        });
        expect(await run.exited).toBe(1);
        expect(run.output()).toContain('EACCES');
        expect((await readdir(artifactDirectory)).filter(name => name.startsWith('hidden-packaged-app-'))).toEqual([]);
    }, 30_000);

    it('refuses a scan-cleanup rerun without touching the earlier run\'s evidence', async () => {
        const evidence = {
            'rome-packaged-source.pdf': 'earlier-source',
            'rome-pane-geometry-source.pdf': 'earlier-geometry',
            'rome-packaged-cleaned.pdf': 'earlier-output',
            'native-metadata/page-1.json': 'earlier-metadata',
            'electron-logs/app.log': 'earlier-log',
            '.packaged-automation-owner': 'earlier-owner',
            'packaged-run/.packaged-automation-owner': 'earlier-owner',
        };
        let artifactDirectory = '';
        const run = await launch('exit 0\n', {}, undefined, {
            script: 'scripts/release/verifyPackagedScanCleanup.ts',
            scriptArguments: (root) => {
                artifactDirectory = join(root, 'artifacts');
                writeFileSync(join(root, 'new-source.pdf'), 'new-source');
                for (const [
                    name,
                    contents,
                ] of Object.entries(evidence)) {
                    mkdirSync(join(artifactDirectory, name, '..'), {recursive: true});
                    writeFileSync(join(artifactDirectory, name), contents);
                }
                return [
                    '--source',
                    join(root, 'new-source.pdf'),
                    '--artifact-dir',
                    artifactDirectory,
                    '--scale-only',
                ];
            },
        });
        expect(await run.exited).not.toBe(0);
        expect(run.output()).toMatch(/empty and unused|already claimed/u);
        for (const [
            name,
            contents,
        ] of Object.entries(evidence)) {
            expect(await readFile(join(artifactDirectory, name), 'utf8')).toBe(contents);
        }
    }, 30_000);

    it('waits for its owned child to exit before removing the bundle on interruption', async () => {
        const run = await launch('trap "exit 0" TERM INT\nwhile :; do sleep 1; done\n');
        let childPid: number | undefined;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const env = await readFile(join(run.workDirectory, 'user-data.env'), 'utf8').catch(() => '');
            if (env) { childPid = Number(env.split('\n')[3]); break; }
            await delay(25);
        }
        if (!childPid) throw new Error(`Fixture did not write user-data.env within 10 seconds. Runner output: ${run.output()}`);
        expect(childPid).toBeGreaterThan(0);
        run.child.kill('SIGTERM');
        await run.exited;
        expect(isProcessAlive(childPid!)).toBe(false);
        expect((await readdir(run.workDirectory)).filter(name => name.startsWith('hidden-packaged-app-'))).toEqual([]);
    }, 20_000);

    it('cleans up an orphaned helper after the main process exits normally', async () => {
        const run = await launch('sleep 30 &\necho "$!" > "$EVB_AUTOMATION_USER_DATA_DIR.helper"\nexit 0\n');
        expect(await run.exited).toBe(0);
        const helperPid = Number(await readFile(join(run.workDirectory, 'user-data.helper'), 'utf8'));
        expect(helperPid).toBeGreaterThan(0);
        expect(isProcessAlive(helperPid)).toBe(false);
        expect((await readdir(run.workDirectory)).filter(name => name.startsWith('hidden-packaged-app-'))).toEqual([]);
    });
});
