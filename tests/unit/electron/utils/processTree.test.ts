import { EventEmitter } from 'node:events';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    processTreeRuntime,
    terminateProcessTree,
} from '@electron/utils/processTree';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
// terminateProcessTree intentionally refuses to signal the current process.
// Avoid fixed PIDs that can collide with the Vitest worker on CI runners.
const makeTestPid = (pid: number) => (pid === process.pid ? pid + 1 : pid);

describePosix('terminateProcessTree (posix)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends SIGTERM and SIGKILL to process group when process stays alive', async () => {
        const pid = makeTestPid(1234);
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        const killSpy = vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((pid, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid,
                signal,
            });

            if (signal === 0) {
                return true;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        const terminated = await terminateProcessTree(pid, {
            graceMs: 0,
            preferProcessGroup: true,
        });

        expect(terminated).toBe(false);
        expect(killSpy).toHaveBeenCalled();
        expect(killCalls.some(call => call.pid === -pid && call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.pid === -pid && call.signal === 'SIGKILL')).toBe(true);
    });

    it('does not send SIGKILL when process exits after SIGTERM', async () => {
        const pid = makeTestPid(4242);
        let alive = true;
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((pid, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid,
                signal,
            });

            if (signal === 0) {
                if (alive) {
                    return true;
                }
                throw new Error('ESRCH');
            }
            if (signal === 'SIGTERM') {
                alive = false;
                return true;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        const terminated = await terminateProcessTree(pid, {
            graceMs: 1_000,
            preferProcessGroup: false,
        });

        expect(terminated).toBe(true);
        expect(killCalls.some(call => call.pid === pid && call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.signal === 'SIGKILL')).toBe(false);
    });

    it('stops polling once the caller proves the direct target exited', async () => {
        const pid = makeTestPid(4243);
        let now = 0;
        let targetAlive = true;
        const delaySpy = vi.spyOn(processTreeRuntime, 'delay').mockImplementation(async () => {
            now += 100;
        });
        vi.spyOn(processTreeRuntime, 'now').mockImplementation(() => now);
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((targetPid, signal?: NodeJS.Signals | 0) => {
            if (signal === 0) {
                return targetPid === pid;
            }
            if (targetPid === pid && signal === 'SIGTERM') {
                targetAlive = false;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        await expect(terminateProcessTree(pid, {
            graceMs: 1_000,
            isTargetAlive: () => targetAlive,
            preferProcessGroup: false,
        })).resolves.toBe(true);

        expect(delaySpy).not.toHaveBeenCalled();
    });

    it('falls back to the direct PID when no process group exists', async () => {
        const pid = makeTestPid(4342);
        let directAlive = true;
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((targetPid, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid: targetPid,
                signal,
            });
            if (signal === 0) {
                if (targetPid === -pid) {
                    throw new Error('ESRCH: process group was never created');
                }
                if (targetPid === pid && directAlive) {
                    return true;
                }
                throw new Error('ESRCH');
            }
            if (targetPid === pid && signal === 'SIGTERM') {
                directAlive = false;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        await expect(terminateProcessTree(pid, {
            graceMs: 0,
            preferProcessGroup: true,
        })).resolves.toBe(true);

        expect(killCalls).toContainEqual({
            pid,
            signal: 'SIGTERM',
        });
        expect(killCalls.some(call => call.pid === -pid && call.signal !== 0)).toBe(false);
    });

    it('finishes the detached process group after its leader exits', async () => {
        const pid = makeTestPid(4343);
        let originalTargetAlive = true;
        let processGroupAlive = true;
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined
        }> = [];
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((targetPid, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid: targetPid,
                signal,
            });
            if (signal === 0 && targetPid === -pid) {
                if (processGroupAlive) {
                    return true;
                }
                throw new Error('ESRCH');
            }
            if (signal === 'SIGTERM') {
                originalTargetAlive = false;
            }
            if (signal === 'SIGKILL') {
                processGroupAlive = false;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        const terminated = await terminateProcessTree(pid, {
            graceMs: 0,
            isTargetAlive: () => originalTargetAlive,
            preferProcessGroup: true,
        });

        expect(terminated).toBe(true);
        expect(killCalls.some(call => call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.signal === 'SIGKILL')).toBe(true);
    });
});

describe('terminateProcessTree (win32 taskkill)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('bounds stuck taskkill helpers and trusts the confirmed target exit', async () => {
        vi.useFakeTimers();
        const pid = makeTestPid(5151);
        const helpers: Array<EventEmitter & {kill: ReturnType<typeof vi.fn>}> = [];
        const spawnSpy = vi.spyOn(processTreeRuntime, 'spawn').mockImplementation((command, args) => {
            const child = new EventEmitter() as EventEmitter & {kill: ReturnType<typeof vi.fn>};
            child.kill = vi.fn();
            helpers.push(child);
            expect(command).toBe('taskkill');
            expect(args).toEqual(expect.arrayContaining([
                '/PID',
                String(pid),
                '/T',
            ]));
            return child as never;
        });
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((targetPid, signal?: NodeJS.Signals | 0) => {
            if (targetPid === pid && signal === 0) {
                if (helpers.filter(helper => helper.kill.mock.calls.length > 0).length >= 2) {
                    throw new Error('ESRCH');
                }
                return true;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        const terminatePromise = terminateProcessTree(pid, {
            graceMs: 0,
            platform: 'win32',
            taskkillTimeoutMs: 50,
        });

        await vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(50);
        await expect(terminatePromise).resolves.toBe(true);

        expect(spawnSpy).toHaveBeenCalledTimes(2);
        expect(spawnSpy.mock.calls[0]?.[1]).not.toContain('/F');
        expect(spawnSpy.mock.calls[1]?.[1]).toContain('/F');
        expect(helpers[0]?.kill).toHaveBeenCalledTimes(1);
        expect(helpers[1]?.kill).toHaveBeenCalledTimes(1);
    });

    it('accepts confirmed process exit when taskkill loses the exit race', async () => {
        const pid = makeTestPid(5252);
        let alive = true;
        vi.spyOn(processTreeRuntime, 'spawn').mockImplementation(() => {
            const child = new EventEmitter() as EventEmitter & {kill: ReturnType<typeof vi.fn>};
            child.kill = vi.fn();
            queueMicrotask(() => {
                alive = false;
                child.emit('close', 1);
            });
            return child as never;
        });
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((targetPid, signal?: NodeJS.Signals | 0) => {
            if (targetPid === pid && signal === 0 && !alive) {
                throw new Error('ESRCH');
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        await expect(terminateProcessTree(pid, {
            graceMs: 0,
            platform: 'win32',
        })).resolves.toBe(true);
    });
});
