import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    statSync: vi.fn(),
    fetch: vi.fn(),
    handle: vi.fn(),
    isReady: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
    config: {
        isDev: false,
        renderer: {staticRoot: '/app/dist'},
    },
}));

vi.mock('node:fs', () => ({
    existsSync: mocks.existsSync,
    statSync: mocks.statSync,
}));
vi.mock('electron', () => ({
    app: {isReady: mocks.isReady},
    net: {fetch: mocks.fetch},
    protocol: {
        handle: mocks.handle,
        registerSchemesAsPrivileged: mocks.registerSchemesAsPrivileged,
    },
}));
vi.mock('@electron/config', () => ({config: mocks.config}));

describe('app protocol', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.config.isDev = false;
        mocks.config.renderer.staticRoot = '/app/dist';
        mocks.isReady.mockReturnValue(true);
        mocks.existsSync.mockReturnValue(false);
        mocks.statSync.mockReturnValue({
            isFile: () => false,
            isDirectory: () => false,
        });
        mocks.fetch.mockImplementation(async () => new Response('asset', {
            status: 200,
            headers: {'content-type': 'application/octet-stream'},
        }));
    });

    it('registers the production scheme with exact privileged options once', async () => {
        const { registerAppProtocolScheme } = await import('@electron/protocol');

        registerAppProtocolScheme();
        registerAppProtocolScheme();

        expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
        expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
            scheme: 'evb-viewer',
            privileges: {
                bypassCSP: false,
                corsEnabled: true,
                secure: true,
                standard: true,
                supportFetchAPI: true,
                codeCache: true,
            },
        }]);
    });

    it('skips handler registration in development and rejects registration before app readiness', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');

        mocks.config.isDev = true;
        setupAppProtocolHandler();
        expect(mocks.handle).not.toHaveBeenCalled();

        vi.resetModules();
        mocks.config.isDev = false;
        mocks.isReady.mockReturnValue(false);
        const fresh = await import('@electron/protocol');
        expect(() => fresh.setupAppProtocolHandler())
            .toThrow('App protocol handler must be registered after Electron app readiness');
    });

    it('serves known assets through net.fetch with a MIME override', async () => {
        mocks.existsSync.mockImplementation((filePath: string) => filePath === '/app/dist/assets/app.js');
        mocks.statSync.mockReturnValue({
            isFile: () => true,
            isDirectory: () => false,
        });
        const { setupAppProtocolHandler } = await import('@electron/protocol');

        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;
        const response = await handler(new Request('evb-viewer://app/assets/app.js'));

        expect(mocks.handle).toHaveBeenCalledWith('evb-viewer', expect.any(Function));
        expect(mocks.fetch).toHaveBeenCalledWith('file:///app/dist/assets/app.js');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    });

    it('caches path resolution across repeated and query-string requests', async () => {
        mocks.existsSync.mockImplementation((filePath: string) => filePath === '/app/dist/assets/app.js');
        mocks.statSync.mockReturnValue({
            isFile: () => true,
            isDirectory: () => false,
        });
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await handler(new Request('evb-viewer://app/assets/app.js?first=1'));
        await handler(new Request('evb-viewer://app/assets/app.js?second=2'));

        expect(mocks.existsSync).toHaveBeenCalledOnce();
        expect(mocks.statSync).toHaveBeenCalledOnce();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it('negatively caches missing URLs and resolves different paths independently', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await handler(new Request('evb-viewer://app/assets/missing.js'));
        await handler(new Request('evb-viewer://app/assets/missing.js?retry=1'));
        await handler(new Request('evb-viewer://app/assets/other.js'));

        expect(mocks.existsSync).toHaveBeenCalledTimes(2);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('bounds the path-resolution cache and evicts the oldest request', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;
        const paths = Array.from({length: 4_097}, (_, index) => `evb-viewer://app/assets/cache-${index}.js`);

        for (const path of paths) {
            await handler(new Request(path));
        }
        await handler(new Request(paths[0]!));

        expect(mocks.existsSync).toHaveBeenCalledTimes(4_098);
    });

    it('validates the extensionless Electron fallback before caching it', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await expect(handler(new Request('evb-viewer://app/electron')))
            .resolves.toMatchObject({status: 404});

        expect(mocks.existsSync).toHaveBeenCalledWith('/app/dist/electron/index.html');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('rejects other hosts and encoded traversal', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await expect(handler(new Request('evb-viewer://evil/assets/app.js')))
            .resolves.toMatchObject({status: 404});
        await expect(handler(new Request('evb-viewer://app/%2e%2e/secret.txt')))
            .resolves.toMatchObject({status: 404});
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});
