import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {windowsTestHostLayout} from '@scripts/windows-test/contracts/windowsTestPaths';
import {createUtmInputCaptureGuard} from '@scripts/windows-test/host/utmInputCapture';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';

const GOLDEN_VM_ID = '11111111-2222-4333-8444-555555555555';
const CLONE_NAME = 'evb-win-test-20260905T120000Z-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

function fakeUtmctl(name = CLONE_NAME): IUtmctlClient {
    return {
        version: () => Promise.resolve('4.7.5'),
        list: () => Promise.resolve([{
            uuid: GOLDEN_VM_ID,
            status: 'started',
            name,
        }]),
        status: () => Promise.resolve('started'),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        clone: () => Promise.resolve(),
        deleteVm: () => Promise.resolve(),
        ipAddress: () => Promise.resolve([]),
        exec: () => Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            signal: null,
            transportFailure: null,
        }),
        pushFile: () => Promise.resolve(),
        pullFile: () => Promise.resolve(),
    };
}

function fakeRunner(results: Array<Record<string, unknown>>): {
    runner: ICommandRunner;
    calls: string[][];
} {
    const calls: string[][] = [];
    return {
        calls,
        runner: {run: async (_command, args) => {
            calls.push(args);
            const result = results.shift() ?? {};
            return {
                exitCode: 0,
                stdout: JSON.stringify(result),
                stderr: '',
                timedOut: false,
                signal: null,
            };
        }},
    };
}

function probeResult(action: 'release' | 'restore', after = 0, windowTitle = CLONE_NAME) {
    return {
        windowTitle,
        windowAvailable: true,
        before: action === 'release' && after === 0 ? 1 : after,
        after,
        frontmostPid: 101,
        utmPid: 202,
        action,
    };
}

function noWindowProbeResult(action: 'release' | 'restore', windowTitle = CLONE_NAME) {
    return {
        windowTitle,
        windowAvailable: false,
        before: 0,
        after: 0,
        frontmostPid: 101,
        utmPid: 202,
        action,
    };
}

function focusedProbeResult(action: 'release' | 'restore', windowTitle = CLONE_NAME) {
    return {
        windowTitle,
        windowAvailable: true,
        before: 0,
        after: 0,
        frontmostPid: 202,
        utmPid: 202,
        action,
    };
}

describe('UTM input-capture guard', () => {
    it('accepts a verified absence of an on-screen UTM window', async () => {
        const fake = fakeRunner([noWindowProbeResult('release')]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        await expect(guard.ensureReleased(GOLDEN_VM_ID)).resolves.toMatchObject({
            windowAvailable: false,
            after: 0,
        });
    });
    it('releases capture with the supported chord and records launch and cleanup evidence', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-utm-input-capture-'));
        roots.push(root);
        const layout = windowsTestHostLayout(root);
        await mkdir(path.join(layout.runsDir, '20260905T120000Z-0123456789ab'), {recursive: true});
        const fake = fakeRunner([
            probeResult('release'),
            probeResult('restore'),
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            layout,
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        const launch = await guard.ensureReleased(GOLDEN_VM_ID);
        await guard.restoreHostInput();

        expect(launch.after).toBe(0);
        expect(fake.calls).toEqual([
            [
                '--window-title',
                CLONE_NAME,
                '--release',
            ],
            [
                '--window-title',
                CLONE_NAME,
                '--restore',
            ],
        ]);
        expect(JSON.parse(await readFile(
            path.join(layout.runsDir, '20260905T120000Z-0123456789ab', 'input-capture-launch.json'),
            'utf8',
        ))).toMatchObject({
            phase: 'launch',
            after: 0,
            hostInputAvailable: true,
        });
        expect(JSON.parse(await readFile(
            path.join(layout.runsDir, '20260905T120000Z-0123456789ab', 'input-capture-cleanup.json'),
            'utf8',
        )).phase).toBe('cleanup');
    });

    it('fails closed when the release chord leaves capture enabled', async () => {
        const fake = fakeRunner([probeResult('release', 1)]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        await expect(guard.ensureReleased(GOLDEN_VM_ID)).rejects.toThrow(/remained enabled/u);
    });

    it('fails closed when UTM remains focused after the launch check', async () => {
        const fake = fakeRunner([focusedProbeResult('release')]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        await expect(guard.ensureReleased(GOLDEN_VM_ID)).rejects.toThrow(/remained focused/u);
    });

    it('records an off state across repeated disposable cold-reset lifecycles', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-utm-input-capture-'));
        roots.push(root);
        const layout = windowsTestHostLayout(root);
        const secondCloneName = 'evb-win-test-20260905T120001Z-abcdef012345';
        await mkdir(path.join(layout.runsDir, '20260905T120000Z-0123456789ab'), {recursive: true});
        await mkdir(path.join(layout.runsDir, '20260905T120001Z-abcdef012345'), {recursive: true});
        const fake = fakeRunner([
            probeResult('release'),
            probeResult('restore'),
            probeResult('release', 0, secondCloneName),
            probeResult('restore', 0, secondCloneName),
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            layout,
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        const first = await guard.ensureReleased(GOLDEN_VM_ID);
        await guard.restoreHostInput();
        const secondGuard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(secondCloneName),
            layout,
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });
        const second = await secondGuard.ensureReleased(GOLDEN_VM_ID);
        await secondGuard.restoreHostInput();

        expect(first.after).toBe(0);
        expect(second.after).toBe(0);
        expect(JSON.parse(await readFile(
            path.join(layout.runsDir, '20260905T120000Z-0123456789ab', 'input-capture-launch.json'),
            'utf8',
        )).hostInputAvailable).toBe(true);
        expect(JSON.parse(await readFile(
            path.join(layout.runsDir, '20260905T120001Z-abcdef012345', 'input-capture-cleanup.json'),
            'utf8',
        )).hostInputAvailable).toBe(true);
    });

    it('refuses a denied VM before invoking the UI probe', async () => {
        const fake = fakeRunner([]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            deniedVmIds: [GOLDEN_VM_ID],
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        await expect(guard.ensureReleased(GOLDEN_VM_ID)).rejects.toThrow(/denied VM/u);
        expect(fake.calls).toEqual([]);
    });

    it('uses UTM Command+Option release events instead of pressing the checkbox', async () => {
        const source = await readFile(
            path.join(process.cwd(), 'scripts/windows-test/host/utmInputCaptureProbe.swift'),
            'utf8',
        );
        expect(source).toContain('postToPid');
        expect(source).toContain('let commandKey: CGKeyCode = 55');
        expect(source).toContain('let optionKey: CGKeyCode = 58');
        expect(source).toContain('arguments.action == "release" || arguments.action == "restore"');
        expect(source).toContain('hideApplication(pid)');
        expect(source).toContain('CGWindowListCopyWindowInfo');
        expect(source).toContain('windowAvailable: false');
        expect(source).not.toContain('AXPress');
    });
});
