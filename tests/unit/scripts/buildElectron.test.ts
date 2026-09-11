import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {readFileSync} from 'node:fs';
import {WORKER_BUNDLES} from '@electron-worker-bundles/electronWorkerBundles.js';

const mocks = vi.hoisted(() => ({
    build: vi.fn(),
    cp: vi.fn(),
    copyFile: vi.fn(),
    execFileSync: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    stagePrivateSourcemaps: vi.fn(),
    writeFile: vi.fn(),
    realpathSync: vi.fn((path: string) => path),
}));

vi.mock('node:fs/promises', () => ({
    cp: mocks.cp,
    copyFile: mocks.copyFile,
    mkdir: mocks.mkdir,
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));

vi.mock('node:fs', async importOriginal => ({
    ...await importOriginal(),
    realpathSync: mocks.realpathSync,
}));

vi.mock('node:module', () => ({createRequire: () => ({resolve: (specifier: string) => {
    if (specifier === '@napi-rs/canvas/package.json') {
        return '/fixture/node_modules/@napi-rs/canvas/package.json';
    }
    throw new Error(`unexpected fixture resolution: ${specifier}`);
}})}));

vi.mock('node:child_process', () => ({execFileSync: mocks.execFileSync}));

vi.mock('esbuild', () => ({default: {build: mocks.build}}));

vi.mock('@scripts/release/stage-private-sourcemaps.mjs', () => ({stagePrivateSourcemaps: mocks.stagePrivateSourcemaps}));

describe('Electron build script', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('builds the main, preload, and registered utility bundles', async () => {
        vi.stubEnv('EVB_ELECTRON_SOURCEMAP', '1');
        vi.stubEnv('EVB_RELEASE_TARGET_PLATFORM', 'mac');
        vi.stubEnv('EVB_RELEASE_TARGET_ARCH', 'arm64');
        vi.stubEnv('EVB_SENTRY_ENVIRONMENT', 'test');
        vi.stubEnv('SENTRY_DESKTOP_DSN', 'https://public@example.invalid/1');
        mocks.build.mockResolvedValue({metafile: {outputs: {}}});
        mocks.cp.mockResolvedValue(undefined);
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
            if (command === 'git' && args[0] === 'rev-parse') {
                return 'a'.repeat(40);
            }
            return '';
        });

        await import('@scripts/build-electron.mjs');

        expect(mocks.rm).toHaveBeenCalledWith('dist-electron', {
            force: true,
            recursive: true,
        });
        expect(mocks.mkdir).toHaveBeenCalledWith('dist-electron', {recursive: true});
        expect(mocks.build).toHaveBeenCalledTimes(2 + WORKER_BUNDLES.length);
        expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
            bundle: true,
            entryPoints: {main: 'electron/main.ts'},
            metafile: true,
            outdir: 'dist-electron',
            sourcemap: 'external',
        }));
        expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
            bundle: true,
            entryPoints: ['electron/preload.ts'],
            metafile: true,
            outfile: 'dist-electron/preload.cjs',
            sourcemap: false,
        }));
        expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
            entryPoints: {main: 'electron/main.ts'},
            define: expect.objectContaining({
                '__EVB_SENTRY_BUILD_IDENTITY__': JSON.stringify({
                    target: 'desktop',
                    release: `evb-viewer-desktop@${JSON.parse(readFileSync('package.json', 'utf8')).version}`,
                    dist: 'macos-arm64',
                    environment: 'test',
                }),
                'process.env.EVB_SENTRY_RELEASE': JSON.stringify(
                    `evb-viewer-desktop@${JSON.parse(readFileSync('package.json', 'utf8')).version}`,
                ),
                'process.env.EVB_SENTRY_DIST': JSON.stringify('macos-arm64'),
                'process.env.EVB_SENTRY_ENVIRONMENT': JSON.stringify('test'),
                '__EVB_SENTRY_DESKTOP_DSN__': JSON.stringify('https://public@example.invalid/1'),
                'process.env.SENTRY_DESKTOP_DSN': JSON.stringify('https://public@example.invalid/1'),
            }),
        }));
        expect(mocks.copyFile).toHaveBeenCalledWith(
            'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
            'dist-electron/pdf.worker.mjs',
        );
        expect(mocks.cp).toHaveBeenCalledWith(
            '/fixture/node_modules/@napi-rs/canvas',
            'dist-electron/runtime/@napi-rs/canvas',
            {recursive: true},
        );
        expect(mocks.cp).toHaveBeenCalledWith(
            '/fixture/node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node',
            'dist-electron/runtime/@napi-rs/canvas/skia.linux-arm64-gnu.node',
        );
        expect(mocks.realpathSync).toHaveBeenCalledWith(
            '/fixture/node_modules/@napi-rs/canvas',
        );
        expect(mocks.realpathSync).toHaveBeenCalledWith(
            '/fixture/node_modules/@napi-rs/canvas-linux-arm64-gnu',
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            'dist-electron/package.json',
            `${JSON.stringify({type: 'module'}, null, 4)}\n`,
        );
        expect(mocks.stagePrivateSourcemaps).toHaveBeenCalledWith({
            identity: {
                target: 'desktop',
                release: `evb-viewer-desktop@${JSON.parse(readFileSync('package.json', 'utf8')).version}`,
                dist: 'macos-arm64',
                environment: 'test',
            },
            outputRoots: ['dist-electron'],
            resetCompletedIdentityLock: true,
        });
    });
});
