import {spawn} from 'node:child_process';
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
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

describe.skipIf(process.platform !== 'darwin')('packaged automation runner lifecycle', () => {
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

    async function launch(body: string) {
        const root = await mkdtemp(join(tmpdir(), 'evb-runner-test-'));
        roots.push(root);
        const app = join(root, 'Fixture.app');
        await mkdir(join(app, 'Contents', 'MacOS'), {recursive: true});
        const executable = join(app, 'Contents', 'MacOS', 'Fixture');
        await writeFile(executable, '#!/bin/sh\n'
            + 'printf "%s\\n" "$EVB_AUTOMATION_HIDE_WINDOW" "$EVB_AUTOMATION_NO_FOCUS" "${ELECTRON_RUN_AS_NODE-unset}" "$$" > "$EVB_AUTOMATION_USER_DATA_DIR.env"\n'
            + body, {mode: 0o755});
        await writeFile(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?>'
            + '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>');
        const workDirectory = join(root, 'run');
        const child = spawn(process.execPath, [
            '--import',
            'tsx',
            resolve('scripts/release/runPackagedAutomation.ts'),
            '--executable',
            executable,
            '--work-directory',
            workDirectory,
        ], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                EVB_AUTOMATION_HIDE_WINDOW: '0',
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
