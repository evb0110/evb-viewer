import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { promisify } from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';

const expectedClasses = [
    'bitonal-faint-pencil',
    'color-text-stamps-maps',
    'photo-art',
    'layered',
    'mixed-dpi',
    'huge-pages',
    'corrupt-missing-tool-enospc',
    'browser-tiff',
    'browser-boundary',
] as const;
const execFileAsync = promisify(execFile);
const DJVU_TOOL_TIMEOUT_MS = 15_000;
const DJVU_TEST_TIMEOUT_MS = DJVU_TOOL_TIMEOUT_MS + 5_000;
const corpusDirectory = resolve(process.cwd(), 'tests/fixtures/djvu');
const hostResourceDirectory = `${process.platform}-${process.arch}`;
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const hostHasDjvuTools = [
    'darwin-arm64',
    'linux-x64',
    'win32-x64',
].includes(hostResourceDirectory);

function djvuToolPath(tool: 'ddjvu' | 'djvused') {
    return resolve(
        process.cwd(),
        'resources/djvulibre',
        hostResourceDirectory,
        'bin',
        `${tool}${executableSuffix}`,
    );
}

async function loadManifest() {
    return JSON.parse(await readFile(resolve(corpusDirectory, 'corpus-manifest.json'), 'utf8')) as IDjvuCorpusManifest;
}

interface IDjvuCorpusManifest {
    schemaVersion: number;
    comparisonScale: string;
    classes: Array<{
        fixture: string | null;
        id: string;
        license: string | null;
        sha256: string | null;
        status: 'acquisition-required' | 'ready';
    }>;
}

describe('DjVu fidelity corpus manifest', () => {
    it('tracks every required quality class without treating missing evidence as passing', async () => {
        const manifest = await loadManifest();

        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.comparisonScale).toBe('matched-physical-page-size');
        expect(manifest.classes.map(entry => entry.id)).toEqual(expectedClasses);
        for (const entry of manifest.classes) {
            if (entry.status === 'ready') {
                expect(entry.fixture).toMatch(/\.djvu$/iu);
                expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
                expect(entry.license).toBeTruthy();
                const fixture = await readFile(resolve(corpusDirectory, entry.fixture!));
                expect(createHash('sha256').update(fixture).digest('hex')).toBe(entry.sha256);
            } else {
                expect(entry.fixture).toBeNull();
                expect(entry.sha256).toBeNull();
                expect(entry.license).toBeNull();
            }
        }
    });
});

describe.skipIf(!hostHasDjvuTools)('generated DjVu fidelity goldens', () => {
    const goldenCases = [
        [
            'bitonal-faint-pencil.djvu',
            'bitonal-faint-pencil-page-1-72dpi.ppm',
            1,
        ],
        [
            'bitonal-faint-pencil.djvu',
            'bitonal-faint-pencil-page-2-72dpi.ppm',
            2,
        ],
        [
            'color-text-stamps-maps.djvu',
            'color-text-stamps-maps-72dpi.ppm',
            1,
        ],
        [
            'photo-art.djvu',
            'photo-art-72dpi.ppm',
            1,
        ],
        [
            'layered.djvu',
            'layered-72dpi.ppm',
            1,
        ],
        [
            'mixed-dpi.djvu',
            'mixed-dpi-page-1-72dpi.ppm',
            1,
        ],
        [
            'mixed-dpi.djvu',
            'mixed-dpi-page-2-72dpi.ppm',
            2,
        ],
    ] as const;

    for (const [
        source,
        golden,
        page,
    ] of goldenCases) {
        it(`matches ${golden} at physical 72-DPI scale`, async () => {
            const directory = await mkdtemp(join(tmpdir(), 'evb-djvu-golden-'));
            const rendered = join(directory, golden);
            try {
                await execFileAsync(djvuToolPath('ddjvu'), [
                    '-format=ppm',
                    '-scale=72',
                    `-page=${page}`,
                    resolve(corpusDirectory, 'sources', source),
                    rendered,
                ], {timeout: DJVU_TOOL_TIMEOUT_MS});
                expect(await readFile(rendered)).toEqual(await readFile(resolve(corpusDirectory, 'goldens', golden)));
            } finally {
                await rm(directory, {
                    force: true,
                    recursive: true,
                });
            }
        }, DJVU_TEST_TIMEOUT_MS);
    }

    it('proves the huge-page admission boundary and browser fixture page counts', async () => {
        const [
            {stdout: hugeSize},
            {stdout: boundaryPages},
            {stdout: tiffPages},
        ] = await Promise.all([
            execFileAsync(djvuToolPath('djvused'), [
                resolve(corpusDirectory, 'sources/huge-page.djvu'),
                '-e',
                'size',
            ], {timeout: DJVU_TOOL_TIMEOUT_MS}),
            execFileAsync(djvuToolPath('djvused'), [
                resolve(corpusDirectory, 'sources/browser-boundary-501-pages.djvu'),
                '-e',
                'n',
            ], {timeout: DJVU_TOOL_TIMEOUT_MS}),
            execFileAsync(djvuToolPath('djvused'), [
                resolve(corpusDirectory, 'sources/browser-tiff-5-pages.djvu'),
                '-e',
                'n',
            ], {timeout: DJVU_TOOL_TIMEOUT_MS}),
        ]);

        expect(hugeSize).toContain('width=10000 height=8001');
        expect(boundaryPages.trim()).toBe('501');
        expect(tiffPages.trim()).toBe('5');
    }, DJVU_TEST_TIMEOUT_MS);

    it('rejects the deterministic truncated DjVu fixture', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-djvu-corrupt-'));
        try {
            await expect(execFileAsync(djvuToolPath('ddjvu'), [
                resolve(corpusDirectory, 'sources/corrupt-truncated.djvu'),
                join(directory, 'output.ppm'),
            ], {timeout: DJVU_TOOL_TIMEOUT_MS})).rejects.toThrow();
        } finally {
            await rm(directory, {
                force: true,
                recursive: true,
            });
        }
    }, DJVU_TEST_TIMEOUT_MS);
});
