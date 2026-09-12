import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    matchesChangedAreaPattern,
    matchWindowsTestChangeAreas,
    selectSuitesForChangedFiles,
    windowsTestChangeAreas,
    windowsTestFamilies,
} from '@scripts/windows-test/registry/changeSelector';

interface IChangedAreaClassifierModule {matchesChangedAreaPattern: (filePath: string, pattern: string) => boolean;}

const repositoryRoot = process.cwd();

let referenceMatcher: IChangedAreaClassifierModule['matchesChangedAreaPattern'];
let workingTreeFiles: string[] = [];

beforeAll(async () => {
    const classifierPath = path.resolve(repositoryRoot, 'scripts/ci/classify-changed-areas.mjs');
    const loaded: unknown = await import(pathToFileURL(classifierPath).href);
    const module = loaded as IChangedAreaClassifierModule;
    referenceMatcher = module.matchesChangedAreaPattern;
    const listing = spawnSync('git', [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    expect(listing.status, listing.stderr).toBe(0);
    workingTreeFiles = listing.stdout.split('\n').filter(entry => entry.length > 0);
});

describe('matchesChangedAreaPattern', () => {
    const cases: ReadonlyArray<[string, string]> = [
        [
            'electron/main.ts',
            'electron/main.ts',
        ],
        [
            'electron/main.ts',
            'electron/*.ts',
        ],
        [
            'electron/window/create.ts',
            'electron/*.ts',
        ],
        [
            'electron/window/create.ts',
            'electron/**',
        ],
        [
            'electron/window/nested/deep.ts',
            'electron/window/**',
        ],
        [
            'packages/pdf-core/src/index.ts',
            'packages/pdf-core/**',
        ],
        [
            'scripts/release/policy.mjs',
            'scripts/release/**',
        ],
        [
            'scripts/bundle-tools-windows.sh',
            'scripts/bundle-tools-windows.sh',
        ],
        [
            'app/modules/pdf-viewer/components/PdfPrintDialog.vue',
            'app/modules/pdf-viewer/components/**',
        ],
        [
            './electron/main.ts',
            'electron/main.ts',
        ],
        [
            'electron/mainX.ts',
            'electron/main.ts',
        ],
        [
            'electronmain.ts',
            'electron/main.ts',
        ],
        [
            'docs/internal/research/plan.md',
            'electron/**',
        ],
        [
            'a+b/c.ts',
            'a+b/*.ts',
        ],
        [
            'electron/updates.ts',
            'electron/updates/**',
        ],
    ];

    it('matches the classifier glob semantics on every probe', () => {
        for (const [
            filePath,
            pattern,
        ] of cases) {
            expect(
                matchesChangedAreaPattern(filePath, pattern),
                `${filePath} against ${pattern}`,
            ).toBe(referenceMatcher(filePath, pattern));
        }
    });

    it('matches the classifier on every declared Windows lane pattern', () => {
        const probes = [
            ...workingTreeFiles.slice(0, 400),
            'electron/main.ts',
            'electron/security/csp.ts',
            'native/pdf-page-ops/src/lib.rs',
            'tests/windows/capabilities.json',
        ];
        for (const area of windowsTestChangeAreas) {
            for (const pattern of area.paths) {
                for (const probe of probes) {
                    expect(
                        matchesChangedAreaPattern(probe, pattern),
                        `${probe} against ${pattern}`,
                    ).toBe(referenceMatcher(probe, pattern));
                }
            }
        }
    });
});

describe('windowsTestChangeAreas', () => {
    it('gives every pattern at least one file that exists in the working tree', () => {
        const unmatched: string[] = [];
        for (const area of windowsTestChangeAreas) {
            for (const pattern of area.paths) {
                const matched = workingTreeFiles.some(file => matchesChangedAreaPattern(file, pattern));
                if (!matched) {
                    unmatched.push(`${area.id}: ${pattern}`);
                }
            }
        }
        expect(unmatched).toEqual([]);
    });

    it('uses unique area IDs and non-empty reasons', () => {
        const ids = windowsTestChangeAreas.map(area => area.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const area of windowsTestChangeAreas) {
            expect(area.reason.length).toBeGreaterThan(0);
            expect(area.families.length).toBeGreaterThan(0);
            expect(area.suites.length).toBeGreaterThan(0);
        }
    });
});

describe('selectSuitesForChangedFiles', () => {
    it('always includes the smoke suite, even for an unrelated change', () => {
        const selection = selectSuitesForChangedFiles(['README.md']);
        expect(selection.suites).toEqual(['smoke']);
        expect(selection.areas).toEqual([]);
        expect(selection.families).toEqual([]);
    });

    it('escalates a print change to the critical suite and the printing family', () => {
        const selection = selectSuitesForChangedFiles(['electron/features/documents/main/print.ts']);
        expect(selection.suites).toEqual([
            'smoke',
            'critical',
        ]);
        expect(selection.areas).toContain('print-and-csp');
        expect(selection.families).toContain(windowsTestFamilies.printing);
    });

    it('escalates a lane change to the full catalogue', () => {
        const selection = selectSuitesForChangedFiles(['scripts/windows-test/registry/changeSelector.ts']);
        expect(selection.suites).toEqual([
            'smoke',
            'critical',
            'all',
        ]);
        expect(selection.families).toHaveLength(Object.keys(windowsTestFamilies).length);
    });

    it('treats an unknown change set as the full catalogue', () => {
        const selection = selectSuitesForChangedFiles(null);
        expect(selection.suites).toEqual([
            'smoke',
            'critical',
            'all',
        ]);
        expect(selection.areas).toEqual(windowsTestChangeAreas.map(area => area.id));
    });

    it('merges several areas without duplicating suites or families', () => {
        const selection = selectSuitesForChangedFiles([
            'electron/file-access/pathIdentity.ts',
            'electron/menu.ts',
            '',
        ]);
        expect(new Set(selection.suites).size).toBe(selection.suites.length);
        expect(new Set(selection.families).size).toBe(selection.families.length);
        expect(selection.areas).toEqual(expect.arrayContaining([
            'revision-and-save',
            'windows-path-and-process',
            'desktop-input',
        ]));
    });

    it('reports matched areas through the low-level matcher too', () => {
        const areas = matchWindowsTestChangeAreas(['native/pdf-page-ops/Cargo.toml']);
        expect(areas.map(area => area.id)).toEqual(expect.arrayContaining([
            'revision-and-save',
            'native-tools',
        ]));
    });
});
