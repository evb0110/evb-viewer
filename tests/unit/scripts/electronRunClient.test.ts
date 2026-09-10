import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('electron run client', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('rethrows command failures without retrying them as readiness failures', async () => {
        const delay = vi.fn();
        vi.doMock('es-toolkit/promise', () => ({ delay }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionArtifacts', () => ({ getSessionInfo: () => ({
            port: 39201,
            pid: 1,
            cdpPort: 39202,
            electronPid: null,
            nuxtPid: null,
            nuxtPort: 3235,
        }) }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionPaths', () => ({ getCurrentSessionName: () => 'test-session' }));

        const fetch = vi.fn(async () => ({ json: async () => ({
            success: false,
            error: 'Command exploded',
        }) }));
        vi.stubGlobal('fetch', fetch);

        const { sendCommand } = await import('@scripts/electron-run/sendCommand');

        await expect(sendCommand('ping')).rejects.toThrow('Command exploded');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(delay).not.toHaveBeenCalled();
    });

    it('reports an uncertain command without replaying a timed-out request', async () => {
        const delay = vi.fn();
        vi.doMock('es-toolkit/promise', () => ({ delay }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionArtifacts', () => ({ getSessionInfo: () => ({
            port: 39201,
            pid: 1,
            cdpPort: 39202,
            electronPid: null,
            nuxtPid: null,
            nuxtPort: 3235,
        }) }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionPaths', () => ({ getCurrentSessionName: () => 'test-session' }));

        const fetch = vi.fn(async () => {
            throw new DOMException('The operation timed out', 'TimeoutError');
        });
        vi.stubGlobal('fetch', fetch);

        const {sendCommand} = await import('@scripts/electron-run/sendCommand');

        await expect(sendCommand('run', ['mutate'], 10)).rejects.toMatchObject({
            name: 'ElectronRunCommandUncertainError',
            message: expect.stringContaining('session \'test-session\''),
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(delay).not.toHaveBeenCalled();
    });

    it('retries a health transport race explicitly marked as safe', async () => {
        const delay = vi.fn(async () => undefined);
        vi.doMock('es-toolkit/promise', () => ({ delay }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionArtifacts', () => ({ getSessionInfo: () => ({
            port: 39201,
            pid: 1,
            cdpPort: 39202,
            electronPid: null,
            nuxtPid: null,
            nuxtPort: 3235,
        }) }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionPaths', () => ({ getCurrentSessionName: () => 'test-session' }));

        const fetch = vi.fn()
            .mockRejectedValueOnce(new Error('connection reset'))
            .mockResolvedValueOnce({json: async () => ({
                success: true,
                result: {ready: true},
            })});
        vi.stubGlobal('fetch', fetch);

        const {sendCommand} = await import('@scripts/electron-run/sendCommand');

        await expect(sendCommand('health', [], 10, {retryOnTransportFailure: true})).resolves.toEqual({ready: true});
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(delay).toHaveBeenCalledTimes(1);
    });
});
