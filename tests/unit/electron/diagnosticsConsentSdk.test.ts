import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const sdk = vi.hoisted(() => ({
    client: null as {getOptions: () => {enabled?: boolean}} | null,
    init: vi.fn(),
}));

vi.mock('electron', () => ({app: {
    getPath: () => '/tmp/evb-diagnostics-consent-test',
    getVersion: () => '0.0.0',
    isPackaged: true,
}}));
vi.mock('@sentry/core', () => ({
    captureException: vi.fn(() => '0'.repeat(32)),
    getClient: () => sdk.client,
}));
vi.mock('@sentry/electron/main', () => ({
    IPCMode: {Classic: 1},
    init: (options: {enabled?: boolean}) => {
        sdk.init(options);
        sdk.client = {getOptions: () => options};
    },
}));

async function importWithDsn() {
    vi.stubGlobal('__EVB_SENTRY_DSN__', 'https://public@sentry.invalid/1');
    return import('@electron/features/diagnostics/sentry');
}

describe('main diagnostics consent', () => {
    beforeEach(() => {
        vi.resetModules();
        sdk.client = null;
        sdk.init.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('never loads the SDK while consent is %s', async (preference) => {
        const diagnostics = await importWithDsn();

        diagnostics.setMainDiagnosticsPreference(preference);
        await vi.dynamicImportSettled();

        expect(sdk.init).not.toHaveBeenCalled();
    });

    it('loads the SDK once consent is granted and stops sending when it is revoked', async () => {
        const diagnostics = await importWithDsn();

        diagnostics.setMainDiagnosticsPreference('granted');
        await vi.dynamicImportSettled();
        expect(sdk.init).toHaveBeenCalledOnce();
        expect(sdk.client?.getOptions().enabled).toBe(true);

        diagnostics.setMainDiagnosticsPreference('denied');
        expect(sdk.client?.getOptions().enabled).toBe(false);
        expect(sdk.init).toHaveBeenCalledOnce();
    });
});
