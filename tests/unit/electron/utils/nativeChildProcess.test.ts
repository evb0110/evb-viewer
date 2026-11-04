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
