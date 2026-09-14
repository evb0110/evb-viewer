import path from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { resolvePdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getNativeToolBinaryPath } from '@electron/native-tools/getNativeToolBinaryPath';
import {
    getNativeResourcesBaseCandidates,
    resolveNativeResourcesBase,
} from '@electron/native-tools/resolveNativeResourcesBase';
import {
    getNativeToolPathCandidates,
    resolveNativeToolPath,
} from '@electron/native-tools/resolveNativeToolPath';

const mocks = vi.hoisted(() => ({logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}}));

const baseOptions = {
    binaryName: 'evb-pdf-page-ops.exe',
    crateName: 'pdf-page-ops',
    currentDir: '/repo/electron/features/page-ops/main',
    isPackaged: false,
    platformArch: 'win32-arm64',
    projectRoot: '/repo',
    resourcesBase: '/repo/resources',
};

vi.mock('electron', () => ({app: {isPackaged: false}}));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => mocks.logger }));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('native resource base resolution', () => {
    it('probes cwd resources before module-relative resources directories', () => {
        expect(getNativeResourcesBaseCandidates('/repo/dist-electron', '/worktree')).toEqual([
            path.join('/worktree', 'resources'),
            path.join('/repo', 'resources'),
            path.join('/', 'resources'),
            path.join('/', 'resources'),
        ]);
    });

    it('resolves a generic native resource root without requiring OCR resources', () => {
        expect(resolveNativeResourcesBase('/repo/dist-electron', false, {
            cwd: '/worktree',
            exists: candidate => candidate === path.join('/repo', 'resources', 'qpdf'),
        })).toBe(path.join('/repo', 'resources'));
    });

    it('keeps packaged resources on Electron resourcesPath', () => {
        expect(resolveNativeResourcesBase('/app/Contents/Resources/app.asar/dist-electron', true, {resourcesPath: '/app/Contents/Resources'})).toBe('/app/Contents/Resources');
    });
});

describe('PDF native tool path boundary', () => {
    it('resolves Poppler and QPDF paths from the native tools base', () => {
        const popplerBase = path.join('/repo/resources/poppler/darwin-arm64');
        const existingPaths = new Set([
            path.join(popplerBase, 'bin', 'pdfinfo'),
            path.join(popplerBase, 'bin', 'pdftoppm'),
            path.join(popplerBase, 'bin', 'pdftotext'),
            path.join(popplerBase, 'bin', 'pdfimages'),
            path.join(popplerBase, 'share', 'poppler'),
            path.join(popplerBase, 'etc', 'fonts'),
            path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'),
        ]);

        expect(resolvePdfNativeToolPaths({
            exists: candidate => existingPaths.has(candidate),
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'darwin',
            platformArch: 'darwin-arm64',
        })).toEqual({
            pdfinfo: path.join(popplerBase, 'bin', 'pdfinfo'),
            pdftoppm: path.join(popplerBase, 'bin', 'pdftoppm'),
            pdftotext: path.join(popplerBase, 'bin', 'pdftotext'),
            pdfimages: path.join(popplerBase, 'bin', 'pdfimages'),
            popplerDataDir: path.join(popplerBase, 'share', 'poppler'),
            popplerFontConfigDir: path.join(popplerBase, 'etc', 'fonts'),
            qpdf: path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'),
        });
    });

    it('keeps pdfimages and Poppler runtime directories optional', () => {
        expect(resolvePdfNativeToolPaths({
            exists: () => false,
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'linux',
            platformArch: 'linux-x64',
        })).toEqual({
            pdfinfo: 'pdfinfo',
            pdftoppm: 'pdftoppm',
            pdftotext: 'pdftotext',
            qpdf: 'qpdf',
        });
    });
});

describe('native tool binary path primitives', () => {
    it('uses bundled binaries before dev system fallbacks', () => {
        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/qpdf/darwin-arm64',
            exists: candidate => candidate === path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'),
            isPackaged: false,
            name: 'qpdf',
            platform: 'darwin',
        })).toBe(path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'));
    });

    it('keeps the existing macOS Homebrew fallback for development builds', () => {
        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/qpdf/darwin-arm64',
            exists: candidate => candidate === path.join('/opt/homebrew/bin', 'qpdf'),
            isPackaged: false,
            name: 'qpdf',
            platform: 'darwin',
        })).toBe(path.join('/opt/homebrew/bin', 'qpdf'));
    });

    it('throws a standardized missing-binary error for required packaged tools', () => {
        expect(() => getNativeToolBinaryPath({
            dir: '/app/Contents/MacOS/native-tools/qpdf/darwin-arm64',
            exists: () => false,
            isPackaged: true,
            name: 'qpdf',
            platform: 'darwin',
        })).toThrow(`Missing required native tool binary "qpdf" at ${
            path.join('/app/Contents/MacOS/native-tools/qpdf/darwin-arm64', 'bin', 'qpdf')
        }`);
    });

    it('keeps optional missing tools empty and Windows executables suffixed', () => {
        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/poppler/win32-x64',
            exists: () => false,
            isPackaged: false,
            name: 'pdfimages',
            optional: true,
            platform: 'win32',
        })).toBe('');

        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/qpdf/win32-x64',
            exists: candidate => candidate === path.join('/repo/resources/qpdf/win32-x64', 'bin', 'qpdf.exe'),
            isPackaged: false,
            name: 'qpdf',
            platform: 'win32',
        })).toBe(path.join('/repo/resources/qpdf/win32-x64', 'bin', 'qpdf.exe'));
    });
});

describe('native tool path resolution', () => {
    it('probes packaged resources, staged dev binaries, cross targets, and host release output', () => {
        expect(getNativeToolPathCandidates(baseOptions)).toEqual([
            path.join('/repo/resources', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe'),
            path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe'),
            path.join('/repo', 'native', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe'),
            path.join('/repo', 'native', 'target', 'release', 'evb-pdf-page-ops.exe'),
        ]);
    });

    it('uses the launchable Contents/MacOS/native-tools root for packaged macOS tools', () => {
        expect(getNativeToolPathCandidates({
            binaryName: 'evb-pdf-page-ops',
            crateName: 'pdf-page-ops',
            currentDir: '/app/Contents/Resources/app.asar/dist-electron',
            isPackaged: true,
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/app/Contents/Resources',
        })).toEqual([path.join(
            '/app/Contents/MacOS/native-tools',
            'pdf-page-ops',
            'darwin-arm64',
            'bin',
            'evb-pdf-page-ops',
        )]);
    });

    it('prefers the override path when it exists', () => {
        expect(resolveNativeToolPath({
            ...baseOptions,
            envOverridePath: '/custom/evb-pdf-page-ops.exe',
            exists: candidate => candidate === '/custom/evb-pdf-page-ops.exe',
        })).toBe('/custom/evb-pdf-page-ops.exe');
    });

    it('ignores env overrides and cwd-relative fallback candidates in packaged builds by default', () => {
        const bundledPath = path.join('/app/resources', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');
        const stagedPath = path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');
        const crossTargetPath = path.join('/repo', 'native', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe');

        expect(resolveNativeToolPath({
            ...baseOptions,
            envOverridePath: '/custom/evb-pdf-page-ops.exe',
            isPackaged: true,
            resourcesBase: '/app/resources',
            exists: candidate => [
                '/custom/evb-pdf-page-ops.exe',
                bundledPath,
                stagedPath,
                crossTargetPath,
            ].includes(candidate),
        })).toBe(bundledPath);

        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring packaged native tool override'));
    });

    it('logs and rejects packaged cwd-relative fallback candidates when the bundled path is missing', () => {
        const stagedPath = path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');

        expect(resolveNativeToolPath({
            ...baseOptions,
            isPackaged: true,
            resourcesBase: '/app/resources',
            exists: candidate => candidate === stagedPath,
        })).toBeNull();

        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring packaged native tool fallback'));
    });

    it('allows packaged override and fallback diagnostics behind an explicit flag', () => {
        const stagedPath = path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');

        expect(resolveNativeToolPath({
            ...baseOptions,
            envOverridePath: '/custom/evb-pdf-page-ops.exe',
            isPackaged: true,
            allowPackagedDiagnosticsPaths: true,
            resourcesBase: '/app/resources',
            exists: candidate => candidate === '/custom/evb-pdf-page-ops.exe',
        })).toBe('/custom/evb-pdf-page-ops.exe');

        expect(getNativeToolPathCandidates({
            ...baseOptions,
            isPackaged: true,
            allowPackagedDiagnosticsPaths: true,
            resourcesBase: '/app/resources',
        })).toContain(stagedPath);
    });

    it('falls through to the staged dev binary before raw Cargo outputs', () => {
        const stagedPath = path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');
        const crossTargetPath = path.join('/repo', 'native', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe');

        expect(resolveNativeToolPath({
            ...baseOptions,
            exists: candidate => candidate === stagedPath || candidate === crossTargetPath,
        })).toBe(stagedPath);
    });

    it('supports nested non-Rust binary layouts without Cargo fallbacks', () => {
        expect(getNativeToolPathCandidates({
            ...baseOptions,
            binaryName: 'nested-tool.exe',
            binaryRelativePath: [
                'bin',
                'nested-tool',
                'nested-tool.exe',
            ],
            crateName: 'nested-tool',
            includeRustTargetCandidates: false,
        })).toEqual([
            path.join('/repo/resources', 'nested-tool', 'win32-arm64', 'bin', 'nested-tool', 'nested-tool.exe'),
            path.join('/repo', '.tmp', 'nested-tool', 'win32-arm64', 'bin', 'nested-tool', 'nested-tool.exe'),
        ]);
    });
});
