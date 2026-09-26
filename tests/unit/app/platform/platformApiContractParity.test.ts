import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PLATFORM_API_DESCRIPTOR } from '@contracts/platformApi';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

function formatPath(path: readonly string[]) {
    return path.join('.');
}

function readPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const segment of path) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

function collectCallablePaths(
    value: unknown,
    prefix: readonly string[] = [],
    paths: string[] = [],
) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return paths;
    }
    for (const [
        key,
        child,
    ] of Object.entries(value)) {
        const childPath = [
            ...prefix,
            key,
        ];
        if (typeof child === 'function') {
            paths.push(formatPath(childPath));
            continue;
        }
        collectCallablePaths(child, childPath, paths);
    }
    return paths;
}

function expectCallablePathParity(
    api: unknown,
    expectedPaths: ReadonlyArray<readonly string[]>,
) {
    const formattedExpectedPaths = expectedPaths.map(formatPath).sort();
    expect(collectCallablePaths(api).sort()).toEqual(formattedExpectedPaths);
    for (const path of expectedPaths) {
        expect(readPath(api, path), formatPath(path)).toEqual(expect.any(Function));
    }
}

async function createMockedElectronApi() {
    vi.doMock('@electron/preload/debugLogBuffer', () => ({getDebugLogMessages: () => []}));

    const { createElectronApi } = await import('@electron/preload/createElectronApi');
    return createElectronApi({
        invoke: vi.fn(async () => undefined),
        on: vi.fn(),
        send: vi.fn(),
    } as never, {getPathForFile: vi.fn(() => '/tmp/mock.pdf')});
}

describe('platform API contract parity', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps the Electron fixture descriptor-complete', () => {
        const {
            diagnostics,
            ...api
        } = createElectronPlatformApiFixture();
        const descriptorPaths = PLATFORM_API_DESCRIPTOR.methods.map(descriptor => descriptor.path);

        expectCallablePathParity(api, descriptorPaths);
        expectCallablePathParity(diagnostics, [['onDebugLog']]);
    });

    it('keeps mocked Electron preload descriptor-complete', async () => {
        const api = await createMockedElectronApi();
        const descriptorPaths = PLATFORM_API_DESCRIPTOR.methods.map(descriptor => descriptor.path);

        const {
            diagnostics,
            ...platformApi
        } = api;
        // Electron has no in-process PDF combiner; DOCX export streams outside the descriptors.
        expectCallablePathParity(platformApi, [
            ...descriptorPaths.filter(path => path.join('.') !== 'documentPicker.createCombinedPdfFromFiles'),
            ...[
                'beginDocxFileStream',
                'writeDocxFileStreamChunk',
                'commitDocxFileStream',
                'cancelDocxFileStream',
            ]
                .map(method => [
                    'documentFiles',
                    method,
                ]),
        ]);
        expectCallablePathParity(diagnostics, [['onDebugLog']]);
    });
});
