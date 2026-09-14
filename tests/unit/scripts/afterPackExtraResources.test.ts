import { createRequire } from 'node:module';
import {
    chmod,
    mkdir,
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { getErrorMessage } from '@contracts/getErrorMessage';

type TRequiredExtraResourceType = 'directory' | 'file';

interface IAfterPackContext {
    appOutDir: string;
    arch: number | string;
    electronPlatformName: string;
    packager: {
        appInfo: { productFilename: string };
        getResourcesDir: (appOutDir: string) => string;
    };
}

interface IRequiredExtraResource {
    label: string;
    packagedEntries?: Array<{
        label: string;
        relativePath: string;
        type: TRequiredExtraResourceType;
    }>;
    sourcePath: string;
    stagedPath: string;
    tag: string;
    type: TRequiredExtraResourceType;
}

interface IAfterPackModule {
    makeTreeOwnerWritable: (rootPath: string) => void;
    configureWindowsNsisArchiveFilter: (context: IAfterPackContext) => void;
    pruneChromiumLocales: (context: IAfterPackContext) => void;
    removeNativeBuildReceipts: (context: IAfterPackContext) => void;
    assertRequiredExtraResources: (context: IAfterPackContext, options?: {
        projectRoot?: string;
        resourcesDir?: string;
    }) => void;
    requiredExtraResourcesForContext: (context: IAfterPackContext, options?: {
        projectRoot?: string;
        resourcesDir?: string;
    }) => IRequiredExtraResource[];
}

const requireScript = createRequire(import.meta.url);
const {
    assertRequiredExtraResources,
    configureWindowsNsisArchiveFilter,
    makeTreeOwnerWritable,
    pruneChromiumLocales,
    removeNativeBuildReceipts,
    requiredExtraResourcesForContext,
} = requireScript(path.join(process.cwd(), 'scripts/afterPack.cjs')) as IAfterPackModule;

function createContext(platform: string, arch: string, resourcesDir: string): IAfterPackContext {
    return {
        appOutDir: path.dirname(resourcesDir),
        arch,
        electronPlatformName: platform,
        packager: {
            appInfo: { productFilename: 'EVB Viewer' },
            getResourcesDir: () => resourcesDir,
        },
    };
}

async function createRequiredPath(filePath: string, type: TRequiredExtraResourceType) {
    if (type === 'file') {
        await mkdir(path.dirname(filePath), {recursive: true});
        await writeFile(filePath, 'fixture', 'utf8');
        return;
    }

    await mkdir(filePath, {recursive: true});
}

async function createRequiredPaths(entries: IRequiredExtraResource[], side: 'source' | 'staged') {
    await Promise.all(entries.map(async (entry) => {
        const rootPath = side === 'source' ? entry.sourcePath : entry.stagedPath;
        await createRequiredPath(rootPath, entry.type);
        for (const packagedEntry of entry.packagedEntries ?? []) {
            await createRequiredPath(
                path.join(rootPath, packagedEntry.relativePath),
                packagedEntry.type,
            );
        }
    }));
}

function captureErrorMessage(action: () => void) {
    try {
        action();
    } catch (error: unknown) {
        return getErrorMessage(error);
    }

    throw new Error('Expected action to throw');
}

describe('afterPack extraResources preflight', () => {
    it('forces the Nsis7z-compatible filter for Windows packaging', () => {
        const previousFilter = process.env.ELECTRON_BUILDER_7Z_FILTER;

        try {
            delete process.env.ELECTRON_BUILDER_7Z_FILTER;
            configureWindowsNsisArchiveFilter(createContext('win32', 'arm64', '/tmp/resources'));
            expect(process.env.ELECTRON_BUILDER_7Z_FILTER).toBe('BCJ');

            process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ2';
            configureWindowsNsisArchiveFilter(createContext('win32', 'x64', '/tmp/resources'));
            expect(process.env.ELECTRON_BUILDER_7Z_FILTER).toBe('BCJ');

            process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ2';
            configureWindowsNsisArchiveFilter(createContext('linux', 'arm64', '/tmp/resources'));
            expect(process.env.ELECTRON_BUILDER_7Z_FILTER).toBe('BCJ2');
        } finally {
            if (previousFilter === undefined) {
                delete process.env.ELECTRON_BUILDER_7Z_FILTER;
            } else {
                process.env.ELECTRON_BUILDER_7Z_FILTER = previousFilter;
            }
        }
    });

    it('removes native build receipts from packaged runtime resources', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-receipts-'));
        const resourcesDir = path.join(tempRoot, 'app-out', 'resources');
        const context = createContext('linux', 'x64', resourcesDir);
        const entries = requiredExtraResourcesForContext(context, {projectRoot: tempRoot})
            .filter(entry => (
                entry.type === 'directory'
                && entry.packagedEntries !== undefined
                && entry.label !== 'tessdata directory'
            ));

        try {
            for (const entry of entries) {
                await mkdir(entry.stagedPath, {recursive: true});
                await writeFile(
                    path.join(entry.stagedPath, 'build-receipt.json'),
                    '{}',
                    'utf8',
                );
                await writeFile(path.join(entry.stagedPath, 'runtime-marker'), 'keep', 'utf8');
            }

            removeNativeBuildReceipts(context);

            for (const entry of entries) {
                await expect(
                    stat(path.join(entry.stagedPath, 'build-receipt.json')),
                ).rejects.toMatchObject({code: 'ENOENT'});
                await expect(
                    stat(path.join(entry.stagedPath, 'runtime-marker')),
                ).resolves.toBeDefined();
            }
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it.each([
        {
            platform: 'darwin',
            retained: [
                'de',
                'en',
                'es',
                'fr',
                'it',
                'nl',
                'pt_BR',
                'pt_PT',
                'ru',
            ],
            removed: 'ja',
        },
        {
            platform: 'linux',
            retained: [
                'de',
                'en-US',
                'es',
                'fr',
                'it',
                'nl',
                'pt-BR',
                'pt-PT',
                'ru',
            ],
            removed: 'ja',
        },
        {
            platform: 'win32',
            retained: [
                'de',
                'en-US',
                'es',
                'fr',
                'it',
                'nl',
                'pt-BR',
                'pt-PT',
                'ru',
            ],
            removed: 'ja',
        },
    ])('prunes Chromium locales to the nine supported product locales on $platform', async (fixture) => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-locales-'));
        const resourcesDir = fixture.platform === 'darwin'
            ? path.join(tempRoot, 'EVB Viewer.app', 'Contents', 'Resources')
            : path.join(tempRoot, 'resources');
        const context = createContext(fixture.platform, 'arm64', resourcesDir);
        context.appOutDir = tempRoot;
        const localeRoot = fixture.platform === 'darwin'
            ? path.join(
                tempRoot,
                'EVB Viewer.app',
                'Contents',
                'Frameworks',
                'Electron Framework.framework',
                'Versions',
                'A',
                'Resources',
            )
            : path.join(tempRoot, 'locales');

        try {
            for (const locale of [
                ...fixture.retained,
                fixture.removed,
                ...(fixture.platform === 'darwin' ? ['en_FEMININE'] : []),
            ]) {
                const localePath = fixture.platform === 'darwin'
                    ? path.join(localeRoot, `${locale}.lproj`, 'locale.pak')
                    : path.join(localeRoot, `${locale}.pak`);
                await mkdir(path.dirname(localePath), {recursive: true});
                await writeFile(localePath, locale, 'utf8');
            }

            pruneChromiumLocales(context);

            for (const locale of fixture.retained) {
                const localePath = fixture.platform === 'darwin'
                    ? path.join(localeRoot, `${locale}.lproj`, 'locale.pak')
                    : path.join(localeRoot, `${locale}.pak`);
                await expect(stat(localePath)).resolves.toBeDefined();
            }
            if (fixture.platform === 'darwin') {
                await expect(stat(path.join(localeRoot, 'en_FEMININE.lproj', 'locale.pak'))).resolves.toBeDefined();
            }
            const removedPath = fixture.platform === 'darwin'
                ? path.join(localeRoot, `${fixture.removed}.lproj`)
                : path.join(localeRoot, `${fixture.removed}.pak`);
            await expect(stat(removedPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('makes read-only updater payloads owner-writable without dropping executable bits', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-permissions-'));
        const readOnlyDirectoryPath = path.join(tempRoot, 'read-only');
        const binaryPath = path.join(tempRoot, 'bin', 'tesseract');
        const libraryPath = path.join(tempRoot, 'lib', 'libtesseract.dylib');

        try {
            await mkdir(path.dirname(binaryPath), {recursive: true});
            await mkdir(path.dirname(libraryPath), {recursive: true});
            await writeFile(binaryPath, 'binary');
            await writeFile(libraryPath, 'library');
            await mkdir(readOnlyDirectoryPath);
            await chmod(binaryPath, 0o555);
            await chmod(libraryPath, 0o444);
            await chmod(readOnlyDirectoryPath, 0o555);

            makeTreeOwnerWritable(tempRoot);

            expect((await stat(binaryPath)).mode & 0o777).toBe(0o755);
            expect((await stat(libraryPath)).mode & 0o777).toBe(0o644);
            expect((await stat(readOnlyDirectoryPath)).mode & 0o777).toBe(0o755);
        } finally {
            await chmod(tempRoot, 0o700).catch(() => undefined);
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('maps every required platform extraResource for the target tag', () => {
        const entries = requiredExtraResourcesForContext(
            createContext('darwin', 'arm64', '/app/EVB Viewer.app/Contents/Resources'),
            {projectRoot: '/repo'},
        );

        expect(entries).toEqual([
            expect.objectContaining({
                label: 'tessdata directory',
                sourcePath: path.join('/repo', 'resources', 'tesseract', 'tessdata'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'tesseract', 'tessdata'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'application resource icon',
                sourcePath: path.join('/repo', 'resources', 'icon.png'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'icon.png'),
                tag: 'darwin-arm64',
                type: 'file',
            }),
            expect.objectContaining({
                label: 'third-party license notices',
                sourcePath: path.join('/repo', 'resources', 'third-party-notices'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'third-party-notices'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'Tesseract native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'tesseract', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'tesseract', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'Poppler native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'poppler', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'poppler', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'qpdf native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'qpdf', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'qpdf', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'DjVuLibre native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'djvulibre', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'djvulibre', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'macOS PDF print dialog helper (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-print-dialog', 'darwin-arm64'),
                stagedPath: path.join(
                    '/app/EVB Viewer.app/Contents/Resources',
                    'pdf-print-dialog',
                    'darwin-arm64',
                ),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'PDF image combine native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-image-combine', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'pdf-image-combine', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'PDF page ops native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-page-ops', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'pdf-page-ops', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'PDF search native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-search', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'pdf-search', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'Scan cleanup native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'scan-cleanup', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'scan-cleanup', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
        ]);
        expect(entries.map(entry => entry.sourcePath).join('\n')).not.toContain('page-processing');
        expect(entries[0]?.packagedEntries).toEqual([{
            label: 'tessdata directory file',
            relativePath: 'pdf.ttf',
            type: 'file',
        }]);
    });

    it('fails with useful source-path messages when required extraResources are absent', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-extra-resources-'));
        const resourcesDir = path.join(tempRoot, 'app-out', 'resources');
        const context = createContext('linux', 'x64', resourcesDir);

        try {
            const message = captureErrorMessage(() => assertRequiredExtraResources(context, {projectRoot: tempRoot}));

            expect(message).toContain('[afterPack] Missing required electron-builder extraResources for linux-x64:');
            expect(message).toContain(path.join(tempRoot, 'resources', 'tesseract', 'tessdata'));
            expect(message).toContain(path.join(tempRoot, '.tmp', 'pdf-search', 'linux-x64'));
            expect(message).not.toContain('page-processing');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('also fails when electron-builder did not stage a required source', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-extra-resources-'));
        const resourcesDir = path.join(tempRoot, 'app-out', 'resources');
        const context = createContext('win32', 'arm64', resourcesDir);
        const entries = requiredExtraResourcesForContext(context, {projectRoot: tempRoot});

        try {
            await createRequiredPaths(entries, 'source');

            const message = captureErrorMessage(() => assertRequiredExtraResources(context, {projectRoot: tempRoot}));

            expect(message).toContain(`packaged PDF search native tool (win32-arm64): ${path.join(resourcesDir, 'pdf-search', 'win32-arm64')}`);

            await createRequiredPaths(entries, 'staged');

            expect(() => assertRequiredExtraResources(context, {projectRoot: tempRoot})).not.toThrow();

            const pdfSearch = entries.find(entry => entry.label.startsWith('PDF search native tool'))!;
            const pdfSearchBinary = pdfSearch.packagedEntries?.find(entry => (
                entry.label === 'evb-pdf-search binary'
            ));
            expect(pdfSearchBinary).toBeDefined();
            await writeFile(
                path.join(pdfSearch.stagedPath, pdfSearchBinary!.relativePath),
                'stale-binary',
                'utf8',
            );
            const mismatchMessage = captureErrorMessage(() => assertRequiredExtraResources(context, {projectRoot: tempRoot}));
            expect(mismatchMessage).toContain('packaged evb-pdf-search binary differs from staged build');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
