import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({spawn: vi.fn()}));

vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => mocks.spawn(...args) }));

function createCodesignChild(stderrText: string, closeCode: number | null) {
    const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        stderr: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    queueMicrotask(() => {
        if (stderrText.length > 0) {
            child.stderr.emit('data', Buffer.from(stderrText));
        }
        child.emit('close', closeCode);
    });

    return child;
}

describe('checkMacCodeSignature', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('process', {
            ...process,
            execPath: '/Applications/EVB Viewer.app/Contents/MacOS/EVB Viewer',
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('requires a verified Developer ID application signature', async () => {
        mocks.spawn
            .mockImplementationOnce(() => createCodesignChild('', 0))
            .mockImplementationOnce(() => createCodesignChild([
                'Authority=Developer ID Application: EVB',
                'TeamIdentifier=ABCDE12345',
            ].join('\n'), 0));

        const { checkMacCodeSignature } = await import('@electron/updates/checkMacCodeSignature');

        await expect(checkMacCodeSignature()).resolves.toBe(true);
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
            '--verify',
            '--deep',
            '--strict',
            '--verbose=2',
            '/Applications/EVB Viewer.app',
        ]);
        expect(mocks.spawn.mock.calls[1]?.[1]).toEqual([
            '-d',
            '--verbose=4',
            '/Applications/EVB Viewer.app',
        ]);
    });

    it('rejects valid but non-Developer-ID signatures', async () => {
        mocks.spawn
            .mockImplementationOnce(() => createCodesignChild('', 0))
            .mockImplementationOnce(() => createCodesignChild('Signature=adhoc\nTeamIdentifier=not set\n', 0));

        const { checkMacCodeSignature } = await import('@electron/updates/checkMacCodeSignature');

        await expect(checkMacCodeSignature()).resolves.toBe(false);
    });

    it('reports an incomplete verification without treating it as an invalid signature', async () => {
        vi.useFakeTimers();
        const child = new EventEmitter() as EventEmitter & {
            kill: ReturnType<typeof vi.fn>;
            stderr: EventEmitter;
        };
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        mocks.spawn.mockReturnValue(child);

        const { checkMacCodeSignature } = await import('@electron/updates/checkMacCodeSignature');
        let settled = false;
        const result = checkMacCodeSignature().finally(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(25_000);
        await expect(result).resolves.toBeNull();
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});
