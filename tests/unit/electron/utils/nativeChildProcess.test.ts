import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
    mkdtemp, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDetachedChildProcessSpawnOptions,
    shouldUseDetachedProcessGroup,
    spawnNativeChildProcess,
    getNativeChildProcessTerminationProof,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';

interface ITerminateProcessTreeOptions {
    graceMs: number;
    isTargetAlive: () => boolean;
    platform: NodeJS.Platform;
    preferProcessGroup: boolean;
}

const processTreeMocks = vi.hoisted(() => ({terminateProcessTree: vi.fn(async (
    _pid: number,
    _options: ITerminateProcessTreeOptions,
) => true)}));

vi.mock('@electron/utils/processTree', () => ({terminateProcessTree: processTreeMocks.terminateProcessTree}));

describe('nativeChildProcess', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses detached process groups on non-Windows platforms', () => {
        expect(shouldUseDetachedProcessGroup('darwin')).toBe(true);
        expect(shouldUseDetachedProcessGroup('linux')).toBe(true);
        expect(shouldUseDetachedProcessGroup('win32')).toBe(false);
    });

    it('preserves caller spawn options while applying detached policy', () => {
        expect(createDetachedChildProcessSpawnOptions({
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
        }, 'darwin')).toMatchObject({
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            detached: true,
        });

        expect(createDetachedChildProcessSpawnOptions({
            shell: false,
            stdio: 'pipe',
        }, 'win32')).toMatchObject({
            shell: false,
            stdio: 'pipe',
            detached: false,
        });
    });

    it.each([
        [
            'linux',
            true,
        ],
        [
            'darwin',
            true,
        ],
        [
            'win32',
            false,
        ],
    ] satisfies Array<[NodeJS.Platform, boolean]>)('terminates the owned PID with the %s process-tree policy', async (
        platform,
        preferProcessGroup,
    ) => {
        const proc = {
            exitCode: null as number | null,
            kill: vi.fn(),
            pid: 4242,
            signalCode: null as NodeJS.Signals | null,
        };

        await terminateDetachedChildProcess(proc as never, 1_500, platform);

        expect(processTreeMocks.terminateProcessTree).toHaveBeenCalledWith(4242, {
            graceMs: 1_500,
            isTargetAlive: expect.any(Function),
            platform,
            preferProcessGroup,
        });
        const options = processTreeMocks.terminateProcessTree.mock.calls.at(-1)?.[1];
        expect(options?.isTargetAlive()).toBe(true);
        proc.exitCode = 0;
        expect(options?.isTargetAlive()).toBe(false);
        proc.exitCode = null;
        proc.signalCode = 'SIGTERM';
        expect(options?.isTargetAlive()).toBe(false);
    });

    it('falls back to direct child termination when spawn never assigned a PID', async () => {
        const proc = {
            exitCode: null,
            kill: vi.fn(),
            pid: undefined,
            signalCode: null,
        };

        await expect(terminateDetachedChildProcess(proc as never, 1_500, 'win32')).resolves.toBe(false);

        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(processTreeMocks.terminateProcessTree).not.toHaveBeenCalled();
    });
    it.each([
        'linux',
        'win32',
    ] as const)('keeps a missing-PID Windows tree unproven even after direct exit (%s)', async platform => {
        const proc = {
            pid: undefined,
            exitCode: 0,
            signalCode: null,
            kill: vi.fn(),
        };
        await expect(terminateDetachedChildProcess(proc as never, 0, platform)).resolves.toBe(platform !== 'win32');
        expect(processTreeMocks.terminateProcessTree).not.toHaveBeenCalled();
    });

});

// These exercise real suspended creation, inherited pipes and whole-job proof.
// The native builder stages the same launcher used in the packaged application.
describe.runIf(process.platform === 'win32')('Windows native Job Object ownership', () => {
    const rootSource = `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0, '127.0.0.1', () => process.send('ready'))"], {
            stdio: ['pipe', 'ignore', 'ignore', 'ipc'], windowsHide: true,
        });
        child.once('message', () => process.stdout.write(JSON.stringify({root: process.pid, child: child.pid}) + '\\n'));
        process.stdin.once('data', () => process.exit(7));
    `;
    function alive(pid: number) {
        try { process.kill(pid, 0); return true; } catch { return false; }
    }
    async function startTree() {
        const proc = spawnNativeChildProcess(process.execPath, [
            '-e',
            rootSource,
        ], {
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
            windowsHide: true,
        });
        const lines = createInterface({input: proc.stdout});
        const [line] = await once(lines, 'line');
        lines.close();
        const tree = JSON.parse(String(line)) as {
            root: number;
            child: number
        };
        expect(alive(tree.root)).toBe(true);
        expect(alive(tree.child)).toBe(true);
        return {
            proc,
            tree,
        };
    }
    it('terminates the entire job before reporting proof', async () => {
        const {
            proc, tree,
        } = await startTree();
        try {
            await expect(terminateDetachedChildProcess(proc, 1_000)).resolves.toBe(true);
            expect(alive(tree.root)).toBe(false);
            expect(alive(tree.child)).toBe(false);
        } finally { proc.kill(); }
    });
    it('contains descendants after the root crashes', async () => {
        const {
            proc, tree,
        } = await startTree();
        try {
            const closed = once(proc, 'close');
            proc.stdin?.end('crash');
            expect((await closed)[0]).toBe(7);
            await expect(getNativeChildProcessTerminationProof(proc)).resolves.toBe(true);
            expect(alive(tree.root)).toBe(false);
            expect(alive(tree.child)).toBe(false);
        } finally { proc.kill(); }
    });
    it('preserves argv, cwd, environment, stdout, stderr and stdin bytes', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'native-job-'));
        const args = [
            '',
            'two words',
            'שלום',
            'quoted"value',
            'trailing\\',
        ];
        const source = 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.B11_CUSTOM})); process.stdin.pipe(process.stderr)';
        const proc = spawnNativeChildProcess(process.execPath, [
            '-e',
            source,
            '--',
            ...args,
        ], {
            cwd,
            env: {
                ...process.env,
                B11_CUSTOM: 'custom-value',
            },
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        proc.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk;});
        proc.stderr.setEncoding('utf8').on('data', chunk => {stderr += chunk;});
        try {
            const closed = once(proc, 'close');
            proc.stdin?.end('input Ω');
            expect((await closed)[0]).toBe(0);
            expect(JSON.parse(stdout)).toEqual({
                args,
                cwd,
                env: 'custom-value',
            });
            expect(stderr).toBe('input Ω');
            await expect(getNativeChildProcessTerminationProof(proc)).resolves.toBe(true);
        } finally { proc.kill(); await rm(cwd, {
            recursive: true,
            force: true,
        }); }
    });
});
