import type * as TViMockOriginalModule from '@electron/utils/platformArch';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { join } from 'node:path';
import { OCR_MODEL_CODES } from '@contracts/ocrLanguages';

const fixturePlatformArch = process.platform === 'win32' ? 'win32-x64' : 'darwin-arm64';
const toolName = (name: string) => process.platform === 'win32' ? `${name}.exe` : name;
const tessdataDir = join('/repo/resources', 'tesseract', 'tessdata');
const tesseractPath = join('/repo/resources', 'tesseract', fixturePlatformArch, 'bin', toolName('tesseract'));
const popplerDataDir = join('/repo/resources/poppler', fixturePlatformArch, 'share', 'poppler');

const INSTALLED_LANGUAGE_CODES = [
    'ara',
    'deu',
    'ell',
    'eng',
    'fra',
    'grc',
    'heb',
    'kmr',
    'rus',
    'syr',
    'tur',
];

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    fileUrl: '/repo/electron/features/ocr/main/paths.ts',
    app: {isPackaged: false},
    ensureRuntimeTessdataSeeded: vi.fn(),
    readdirSync: vi.fn(),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('electron', () => ({app: mocks.app}));
vi.mock('url', () => ({fileURLToPath: () => mocks.fileUrl}));
vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    readdirSync: (path: string) => mocks.readdirSync(path),
}));
vi.mock('child_process', () => ({spawn: vi.fn()}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/utils/platformArch', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    resolvePlatformArchTag: () => fixturePlatformArch,
}));
vi.mock('@electron/features/ocr/languageModels', () => ({
    TESSDATA_BEST_REF: 'test-tessdata-resource-version',
    ensureRuntimeTessdataSeeded: () => mocks.ensureRuntimeTessdataSeeded(),
    getRuntimeTessdataDir: () => tessdataDir,
}));

describe('getOcrToolPaths resource base resolution', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.ensureRuntimeTessdataSeeded.mockResolvedValue(undefined);
        mocks.readdirSync.mockReturnValue([
            ...INSTALLED_LANGUAGE_CODES.map(code => `${code}.traineddata`),
            'README',
        ]);
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: '/usr/bin/tool\n',
            stderr: '',
        });
        mocks.existsSync.mockImplementation((path: string) => [
            join('/repo/resources', 'tesseract'),
            tesseractPath,
            tessdataDir,
            ...(process.platform === 'win32' ? [popplerDataDir] : []),
        ].includes(path));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('builds tool paths from repository resources when loaded from source', async () => {
        const { getOcrToolPaths } = await import('@electron/features/ocr/main/paths');

        expect(getOcrToolPaths()).toMatchObject({
            tesseract: tesseractPath,
            tessdata: tessdataDir,
            pdftoppm: toolName('pdftoppm'),
            pdftotext: toolName('pdftotext'),
            qpdf: toolName('qpdf'),
        });
    });

    it('resolves OCR-owned native paths without Poppler or QPDF fields', async () => {
        const { resolveOcrNativeToolPaths } = await import('@electron/features/ocr/main/nativeToolPaths');

        expect(resolveOcrNativeToolPaths({
            exists: candidate => candidate.includes(join('tesseract', 'darwin-arm64', 'bin')),
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            tessdataDir: '/runtime/tessdata',
        })).toEqual({
            tesseract: join('/repo/resources', 'tesseract', 'darwin-arm64', 'bin', 'tesseract'),
            tessdata: '/runtime/tessdata',
        });
    });

    it('keeps OCR tool paths awaitable so runtime tessdata seeding is preserved', async () => {
        const { getOcrToolPaths } = await import('@electron/features/ocr/main/paths');

        const paths = getOcrToolPaths();

        expect(typeof paths.then).toBe('function');
        await expect(paths).resolves.toMatchObject({
            tesseract: tesseractPath,
            tessdata: tessdataDir,
        });
        expect(mocks.ensureRuntimeTessdataSeeded).toHaveBeenCalled();
    });

    it('validates available OCR tools, language models, and tesseract version', async () => {
        mocks.runNativeToolCommand.mockImplementation(async (command: string) => ({
            exitCode: 0,
            stdout: command.includes('tesseract') ? 'tesseract 5.5.0\n' : '/usr/bin/tool\n',
            stderr: '',
        }));
        const { validateOcrTools } = await import('@electron/features/ocr/main/paths');

        await expect(validateOcrTools()).resolves.toEqual({
            valid: true,
            errors: [],
            tools: {
                tesseract: {
                    found: true,
                    path: tesseractPath,
                    version: '5.5.0',
                },
                tessdata: {
                    found: true,
                    path: tessdataDir,
                    languages: [...INSTALLED_LANGUAGE_CODES],
                    onDemandLanguages: OCR_MODEL_CODES
                        .filter(code => !INSTALLED_LANGUAGE_CODES.includes(code))
                        .sort(),
                },
                pdftoppm: {
                    found: true,
                    path: toolName('pdftoppm'),
                },
                pdftotext: {
                    found: true,
                    path: toolName('pdftotext'),
                },
                popplerRuntime: {
                    dataDirFound: process.platform === 'win32',
                    ...(process.platform === 'win32' ? {dataDir: popplerDataDir} : {}),
                    fontConfigDirFound: false,
                },
                qpdf: {
                    found: true,
                    path: toolName('qpdf'),
                },
            },
        });
        const probeCount = mocks.runNativeToolCommand.mock.calls.length;
        await validateOcrTools();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(probeCount);
    });

    it('reports missing binaries and missing tessdata without probing versions', async () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: -1,
            stdout: '',
            stderr: 'not found',
        });
        const { validateOcrTools } = await import('@electron/features/ocr/main/paths');

        const result = await validateOcrTools();

        expect(result.valid).toBe(false);
        expect(result.tools.tesseract).toEqual({
            found: false,
            path: toolName('tesseract'),
        });
        expect(result.tools.tessdata).toEqual({
            found: false,
            path: tessdataDir,
        });
        expect(result.tools.pdftoppm.found).toBe(false);
        expect(result.tools.pdftotext.found).toBe(false);
        expect(result.tools.qpdf.found).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            `Tesseract binary not found: ${toolName('tesseract')}`,
            `Tessdata directory not found: ${tessdataDir}`,
            `pdftoppm not found: ${toolName('pdftoppm')} (install Poppler or bundle it)`,
            `pdftotext not found: ${toolName('pdftotext')} (install Poppler or bundle it)`,
            `qpdf not found: ${toolName('qpdf')} (install qpdf or bundle it)`,
        ]));
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(process.platform === 'win32' ? 'where' : 'which', [toolName('tesseract')], expect.any(Object));
    });

    it('rejects empty or unreadable tessdata language directories', async () => {
        mocks.readdirSync.mockReturnValue([]);
        const { validateOcrTools } = await import('@electron/features/ocr/main/paths');

        await expect(validateOcrTools()).resolves.toMatchObject({
            valid: false,
            tools: {tessdata: {
                found: true,
                path: tessdataDir,
                languages: [],
            }},
            errors: expect.arrayContaining([`No language models found in tessdata: ${tessdataDir}`]),
        });

        vi.resetModules();
        mocks.readdirSync.mockImplementation(() => {
            throw new Error('permission denied');
        });
        const fresh = await import('@electron/features/ocr/main/paths');
        await expect(fresh.validateOcrTools()).resolves.toMatchObject({
            valid: false,
            tools: {tessdata: {
                found: true,
                path: tessdataDir,
                languages: [],
            }},
        });
    });

    it('accepts packaged defaults and reports other supported models as on demand', async () => {
        mocks.readdirSync.mockReturnValue([
            'eng.traineddata',
            'rus.traineddata',
        ]);
        const { validateOcrTools } = await import('@electron/features/ocr/main/paths');

        const result = await validateOcrTools();

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.tools.tessdata).toMatchObject({
            languages: [
                'eng',
                'rus',
            ],
            onDemandLanguages: expect.arrayContaining([
                'ara',
                'fra',
                'tur',
            ]),
        });
    });

    it('rejects tessdata directories missing a bundled default', async () => {
        mocks.readdirSync.mockReturnValue(['eng.traineddata']);
        const { validateOcrTools } = await import('@electron/features/ocr/main/paths');

        const result = await validateOcrTools();

        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Missing bundled language models in tessdata: rus');
    });
});
