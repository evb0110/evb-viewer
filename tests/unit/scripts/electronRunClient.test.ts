import {createServer} from 'node:http';
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

    it('delivers a mutating command once when the response is delayed', async () => {
        let deliveryCount = 0;
        let resolveDelivery: (() => void) | null = null;
        const deliveryObserved = new Promise<void>(resolve => {
            resolveDelivery = resolve;
        });
        let releaseResponse = () => {};
        const responseReleased = new Promise<void>(resolve => {
            releaseResponse = resolve;
        });
        const server = createServer((_request, response) => {
            deliveryCount += 1;
            resolveDelivery?.();
            void responseReleased.then(() => {
                response.end(JSON.stringify({
                    success: true,
                    result: {mutated: true},
                }));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('command fixture did not expose a TCP port');
        }
        vi.doMock('es-toolkit/promise', () => ({ delay: vi.fn() }));
        vi.doMock('../../../scripts/electron-run/electronRunSessionPaths', () => ({ getCurrentSessionName: () => 'test-session' }));

        try {
            const {
                sendCommandToSession,
                ElectronRunCommandUncertainError,
            } = await import('@scripts/electron-run/sendCommand');
            await expect(sendCommandToSession({
                port: address.port,
                pid: 1,
                cdpPort: 39202,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 3235,
            }, 'run', ['mutate'], 100)).rejects.toBeInstanceOf(ElectronRunCommandUncertainError);
            await deliveryObserved;
            expect(deliveryCount).toBe(1);
        } finally {
            releaseResponse?.();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
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
