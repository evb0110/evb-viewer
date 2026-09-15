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

function windowSnapshot(windowNumbers: number[], enumerationAvailable = true) {
    return {
        enumerationAvailable,
        windowNumbers,
        windows: [],
        utmPid: 202,
        frontmostPid: 101,
    };
}

describe('UTM input-capture guard', () => {
    it('accepts a verified absence of an on-screen UTM window', async () => {
        const fake = fakeRunner([
            windowSnapshot([10]),
            windowSnapshot([10]),
        ]);
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
    it('fails closed when window enumeration is unavailable', async () => {
        const fake = fakeRunner([
            windowSnapshot([], false),
            windowSnapshot([], false),
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        await expect(guard.ensureReleased(GOLDEN_VM_ID)).rejects.toThrow(/enumeration was unavailable/u);
    });

    it('fails closed when a new on-screen UTM window appears', async () => {
        const fake = fakeRunner([
            windowSnapshot([10]),
            windowSnapshot([
                10,
                11,
            ]),
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        await expect(guard.ensureReleased(GOLDEN_VM_ID)).rejects.toThrow(/Screen Recording or Accessibility/u);
    });

    it('verifies the clone checkbox when a new window appears with permissions', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-utm-input-capture-'));
        roots.push(root);
        const layout = windowsTestHostLayout(root);
        const runDirectory = path.join(layout.runsDir, '20260905T120000Z-0123456789ab');
        await mkdir(runDirectory, {recursive: true});
        const fake = fakeRunner([
            windowSnapshot([10]),
            {
                ...windowSnapshot([
                    10,
                    11,
                ]),
                screenCapturePreflight: true,
                accessibilityTrusted: true,
            },
            {
                windowTitle: CLONE_NAME,
                windowAvailable: true,
                before: 0,
                after: 0,
                frontmostPid: 101,
                utmPid: 202,
                action: 'release',
            },
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            layout,
            utmctl: fakeUtmctl(),
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });
        await expect(guard.ensureReleased(GOLDEN_VM_ID)).resolves.toMatchObject({
            windowAvailable: true,
            after: 0,
        });
        expect(JSON.parse(await readFile(path.join(runDirectory, 'input-capture-release-command.json'), 'utf8'))).toMatchObject({
            exitCode: 0,
            stderr: '',
            timedOut: false,
        });
        expect(fake.calls.at(-1)).toEqual([
            '--window-title',
            CLONE_NAME,
            '--release',
        ]);
    });

    it('records launch evidence for a stable UTM window set', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-utm-input-capture-'));
        roots.push(root);
        const layout = windowsTestHostLayout(root);
        await mkdir(path.join(layout.runsDir, '20260905T120000Z-0123456789ab'), {recursive: true});
        const fake = fakeRunner([
            windowSnapshot([10]),
            windowSnapshot([10]),
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            layout,
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        const launch = await guard.ensureReleased(GOLDEN_VM_ID);
        expect(launch.after).toBe(0);
        expect(fake.calls).toEqual([
            ['--snapshot'],
            ['--snapshot'],
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
            path.join(layout.runsDir, '20260905T120000Z-0123456789ab', 'input-capture-launch.json'),
            'utf8',
        )).windowNumbersBefore).toEqual([10]);
    });

    it('records an off state across repeated disposable cold-reset lifecycles', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-utm-input-capture-'));
        roots.push(root);
        const layout = windowsTestHostLayout(root);
        const secondCloneName = 'evb-win-test-20260905T120001Z-abcdef012345';
        await mkdir(path.join(layout.runsDir, '20260905T120000Z-0123456789ab'), {recursive: true});
        await mkdir(path.join(layout.runsDir, '20260905T120001Z-abcdef012345'), {recursive: true});
        const fake = fakeRunner([
            windowSnapshot([10]),
            windowSnapshot([10]),
            windowSnapshot([20]),
            windowSnapshot([20]),
        ]);
        const guard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(),
            layout,
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });

        const first = await guard.ensureReleased(GOLDEN_VM_ID);
        const secondGuard = createUtmInputCaptureGuard({
            runner: fake.runner,
            utmctl: fakeUtmctl(secondCloneName),
            layout,
            probeExecutablePath: '/tmp/utm-input-capture-probe',
        });
        const second = await secondGuard.ensureReleased(GOLDEN_VM_ID);

        expect(first.after).toBe(0);
        expect(second.after).toBe(0);
        expect(JSON.parse(await readFile(
            path.join(layout.runsDir, '20260905T120000Z-0123456789ab', 'input-capture-launch.json'),
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
