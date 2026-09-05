import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    copyFile,
    link,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    join,
    resolve,
} from 'node:path';

import {
    describe,
    expect,
    it,
} from 'vitest';

const { isPdfjsPackagePath } = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/lib/pdfjs-package-path.mjs')).href,
);
const {
    absoluteSourceMapPath,
    inspectArchive,
    parseManifest,
    verify,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/verify-pdfjs-provenance.mjs')).href,
);

describe('PDF.js package path classification', () => {
    it.each([
        'node_modules/pdfjs-dist/build/pdf.mjs',
        'node_modules/.pnpm/pdfjs-dist@5.7.304/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
        'node_modules/.pnpm/file+vendor+pdfjs-dist+pdfjs-dist-5.7.304-f029c046.tgz/node_modules/pdfjs-dist/build/pdf.mjs',
        'node_modules/@evb0110/pdfjs-dist/build/pdf.mjs',
        'node_modules/@pdfjs-dist/pdfjs-dist/build/pdf.mjs',
        '/real/path/to/pdfjs-dist/build/pdf.mjs',
        'C:\\repo\\node_modules\\.pnpm\\pdfjs-dist@5.7.304\\node_modules\\pdfjs-dist\\build\\pdf.mjs',
    ])('recognizes %s', (filePath) => {
        expect(isPdfjsPackagePath(filePath)).toBe(true);
    });

    it.each([
        'node_modules/pdfjs-dist-codex-preview/build/pdf.mjs',
        'node_modules/pdfjs-distive/build/pdf.mjs',
        'src/pdfjs-distive/build/pdf.mjs',
        'src/pdfjs-dist/build/source.js',
    ])('does not recognize %s', (filePath) => {
        expect(isPdfjsPackagePath(filePath)).toBe(false);
    });
});

describe('PDF.js provenance attack fixtures', () => {
    type TFixturePreparation = (root: string) => Promise<unknown> | unknown;

    async function fixtureRoot() {
        const root = await mkdtemp(join(tmpdir(), 'evb-pdfjs-fixture-'));
        await mkdir(join(root, 'package'), {recursive: true});
        await writeFile(join(root, 'package', 'file.js'), 'fixture');
        return root;
    }

    const archiveFixtures: Array<[string, TFixturePreparation]> = [
        [
            'symlink',
            async root => symlink('file.js', join(root, 'package', 'link')),
        ],
        [
            'duplicate',
            async _root => undefined,
        ],
        [
            'hardlink',
            async root => link(join(root, 'package', 'file.js'), join(root, 'package', 'hardlink')),
        ],
        [
            'fifo',
            async root => {
                if (process.platform !== 'win32') {
                    execFileSync('mkfifo', [join(root, 'package', 'fifo')]);
                }
            },
        ],
    ];

    it.each(archiveFixtures)('rejects %s archive entries', async (kind, prepare) => {
        if (kind === 'fifo' && process.platform === 'win32') {
            return;
        }
        const root = await fixtureRoot();
        const archive = join(root, `${kind}.tgz`);
        try {
            await prepare(root);
            const args = kind === 'duplicate'
                ? [
                    '-czf',
                    archive,
                    '-C',
                    root,
                    'package/file.js',
                    'package/file.js',
                ]
                : [
                    '-czf',
                    archive,
                    '-C',
                    root,
                    'package',
                ];
            execFileSync('tar', args);
            expect(() => inspectArchive(archive)).toThrow(/unsupported entry type|duplicate/u);
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rejects manifest traversal, duplicates, and backup artifacts', () => {
        const row = 'a'.repeat(64);
        expect(() => parseManifest(`file\t1\t${row}\t../outside\n`)).toThrow(/unsafe manifest path/u);
        expect(() => parseManifest(`file\t1\t${row}\t/tmp/outside\n`)).toThrow(/unsafe manifest path/u);
        expect(() => parseManifest(`file\t1\t${row}\tC:/outside\n`)).toThrow(/unsafe manifest path/u);
        expect(() => parseManifest(`file\t1\t${row}\tfile.js\nfile\t1\t${row}\tfile.js\n`)).toThrow(/duplicate/u);
        expect(() => parseManifest(`file\t1\t${row}\tfile.js.orig\n`)).toThrow(/unsafe manifest path/u);
    });

    it('rejects absolute source-map forms', async () => {
        expect([
            'C:/repo/file.js',
            '/tmp/file.js',
            '\\\\server\\file.js',
            'file:///tmp/file.js',
            'file:/tmp/file.js',
            'FILE:///tmp/file.js',
        ].every(absoluteSourceMapPath)).toBe(true);
        expect(absoluteSourceMapPath('webpack://pdf.js/./src/shared/util.js')).toBe(false);
    });

    it('rejects archive, manifest, and receipt mismatches before accepting the fixture', async () => {
        const root = await fixtureRoot();
        const vendor = join(root, 'vendor', 'pdfjs-dist');
        await mkdir(vendor, {recursive: true});
        const sourceVendor = resolve(process.cwd(), 'vendor/pdfjs-dist');
        try {
            await Promise.all([
                copyFile(join(sourceVendor, 'pdfjs-dist-5.7.304-f029c046.tgz'), join(vendor, 'pdfjs-dist-5.7.304-f029c046.tgz')),
                copyFile(join(sourceVendor, 'pdfjs-dist-5.7.304-f029c046.files.sha256'), join(vendor, 'pdfjs-dist-5.7.304-f029c046.files.sha256')),
                copyFile(join(sourceVendor, 'provenance.json'), join(vendor, 'provenance.json')),
            ]);
            const receiptPath = join(vendor, 'provenance.json');
            const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
            const verifierSource = await readFile(
                resolve(process.cwd(), 'scripts/verify-pdfjs-provenance.mjs'),
            );
            const verifierSourceSha256 = createHash('sha256').update(verifierSource).digest('hex');
            expect(receipt.verifier.sourceSha256).toBe(verifierSourceSha256);
            receipt.verifier.sourceSha256 = '0'.repeat(64);
            await writeFile(receiptPath, JSON.stringify(receipt));
            await expect(verify({
                projectRoot: process.cwd(),
                archivePath: join(vendor, 'pdfjs-dist-5.7.304-f029c046.tgz'),
                manifestPath: join(vendor, 'pdfjs-dist-5.7.304-f029c046.files.sha256'),
                receiptPath,
            })).rejects.toThrow(/verifier source hash mismatch/u);
            receipt.verifier.sourceSha256 = verifierSourceSha256;
            receipt.archive.sha256 = '0'.repeat(64);
            await writeFile(receiptPath, JSON.stringify(receipt));
            await expect(verify({
                projectRoot: process.cwd(),
                archivePath: join(vendor, 'pdfjs-dist-5.7.304-f029c046.tgz'),
                manifestPath: join(vendor, 'pdfjs-dist-5.7.304-f029c046.files.sha256'),
                receiptPath,
            })).rejects.toThrow(/archive SHA-256 mismatch/u);
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
