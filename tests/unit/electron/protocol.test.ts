import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    readdirSync: vi.fn(),
    fetch: vi.fn(),
    handle: vi.fn(),
    isReady: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
    config: {
        isDev: false,
        renderer: {staticRoot: '/app/dist'},
    },
}));

vi.mock('node:fs', () => ({readdirSync: mocks.readdirSync}));

// Serves directory listings for the given files and their parent directories,
// the only view of the renderer tree the protocol handler reads.
function useStaticFiles(files: string[]) {
    mocks.readdirSync.mockImplementation((directory: string) => {
        const entries = new Map<string, boolean>();
        for (const file of files) {
            if (!file.startsWith(`${directory}/`)) {
                continue;
            }
            const [
                name,
                ...rest
            ] = file.slice(directory.length + 1).split('/');
            entries.set(name!, rest.length > 0);
        }
        if (entries.size === 0) {
            throw Object.assign(new Error(`ENOENT: ${directory}`), {code: 'ENOENT'});
        }
        return [...entries].map(([
            name,
            isDirectory,
        ]) => ({
            name,
            isFile: () => !isDirectory,
            isDirectory: () => isDirectory,
        }));
    });
}
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
        useStaticFiles([]);
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
        useStaticFiles(['/app/dist/assets/app.js']);
        const { setupAppProtocolHandler } = await import('@electron/protocol');

        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;
        const response = await handler(new Request('evb-viewer://app/assets/app.js'));

        expect(mocks.handle).toHaveBeenCalledWith('evb-viewer', expect.any(Function));
        expect(mocks.fetch).toHaveBeenCalledWith('file:///app/dist/assets/app.js');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    });

    it('serves a directory request from its index.html', async () => {
        useStaticFiles(['/app/dist/electron/index.html']);
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        const response = await handler(new Request('evb-viewer://app/electron/'));

        expect(mocks.fetch).toHaveBeenCalledWith('file:///app/dist/electron/index.html');
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    });

    it('caches path resolution across repeated and query-string requests', async () => {
        useStaticFiles(['/app/dist/assets/app.js']);
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await handler(new Request('evb-viewer://app/assets/app.js?first=1'));
        await handler(new Request('evb-viewer://app/assets/app.js?second=2'));

        expect(mocks.readdirSync).toHaveBeenCalledOnce();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it('negatively caches missing URLs and resolves different paths independently', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await handler(new Request('evb-viewer://app/assets/missing.js'));
        await handler(new Request('evb-viewer://app/assets/missing.js?retry=1'));
        await handler(new Request('evb-viewer://app/assets/other.js'));

        expect(mocks.readdirSync).toHaveBeenCalledTimes(2);
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

        expect(mocks.readdirSync).toHaveBeenCalledTimes(4_098);
    });

    it('validates the extensionless Electron fallback before caching it', async () => {
        const { setupAppProtocolHandler } = await import('@electron/protocol');
        setupAppProtocolHandler();
        const handler = mocks.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;

        await expect(handler(new Request('evb-viewer://app/electron')))
            .resolves.toMatchObject({status: 404});

        expect(mocks.readdirSync).toHaveBeenCalledWith('/app/dist/electron', {withFileTypes: true});
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
