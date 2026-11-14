import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import {existsSync} from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const runNativeToolCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({ qpdf: '/mock/qpdf' }),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

describe.runIf(process.platform !== 'win32')('bundled qpdf path bytes at the native seam', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it.each([
        'lf-with-sibling',
        'lf-without-sibling',
        'cr',
        'crlf',
        'output-lf',
        'symlink',
        'relative',
    ] as const)(
        'selects the exact source and writes through staged aliases: %s', async scenario => {
            const {
                PDFDocument, StandardFonts,
            } = await import('pdf-lib');
            const {symlink} = await import('node:fs/promises');
            const {execFile} = await import('node:child_process');
            const {promisify} = await import('node:util');
            const {dirname} = await import('node:path');
            const run = promisify(execFile);
            const qpdf = join(process.cwd(), 'resources', 'qpdf', `${process.platform}-${process.arch}`, 'bin', 'qpdf');
            const directory = await mkdtemp(join(tmpdir(), 'qpdf-path-bytes-'));
            const sentinel = 'EXACT_SOURCE_SENTINEL';
            async function fixture(path: string, count: number, word: string) {
                const document = await PDFDocument.create();
                const font = await document.embedFont(StandardFonts.Helvetica);
                for (let i = 0; i < count; i++) document.addPage().drawText(word, {font});
                await writeFile(path, await document.save());
            }
            const separator = scenario === 'cr' ? '\r' : scenario === 'crlf' ? '\r\n' : '\n';
            const source = join(directory, `source${separator}name.pdf`);
            const output = join(directory, scenario === 'output-lf' ? 'output\nname.pdf' : 'output.pdf');
            const argumentDirs: string[] = [];
            await fixture(source, 1, sentinel);
            if (scenario === 'lf-with-sibling') await fixture(join(directory, 'source name.pdf'), 2, 'WRONG_SPACE_SIBLING');
            let operand = source;
            if (scenario === 'symlink') { operand = join(directory, 'link\nsource.pdf'); await symlink(source, operand); }
            if (scenario === 'relative') operand = `source${separator}name.pdf`;
            runNativeToolCommandMock.mockImplementation(async (_binary: string, args: string[], options: {cwd?: string}) => {
                if (args[0]?.startsWith('@')) argumentDirs.push(dirname(args[0].slice(1)));
                const result = await run(qpdf, args, {cwd: options.cwd});
                return {
                    ...result,
                    exitCode: 0,
                };
            });
            try {
                const {runQpdfCommand} = await import('@electron/features/page-ops/main/qpdf');
                await runQpdfCommand([
                    operand,
                    '--pages',
                    operand,
                    '1-z',
                    '--',
                    output,
                ], {
                    commandLabel: 'qpdf(path-regression)',
                    ...(scenario === 'relative' ? {cwd: directory} : {}),
                });
                const reopened = await PDFDocument.load(await readFile(output));
                expect(reopened.getPageCount()).toBe(1);
                const pages = await run(qpdf, [
                    '--show-pages',
                    output,
                ]);
                const content = /content:\s+(\d+) (\d+) R/u.exec(pages.stdout);
                expect(content).not.toBeNull();
                const stream = await run(qpdf, [
                    `--show-object=${content![1]},${content![2]}`,
                    '--filtered-stream-data',
                    output,
                ]);
                expect(stream.stdout.toUpperCase()).toContain(Buffer.from(sentinel).toString('hex').toUpperCase());
                for (const path of argumentDirs) expect(existsSync(path)).toBe(false);
                expect(existsSync(join(directory, 'output name.pdf'))).toBe(false);
            } finally { await rm(directory, {
                recursive: true,
                force: true,
            }); }
        },
    );

    it('retains every prepared alias and the response file after a marked native rejection', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const {dirname} = await import('node:path');
        const {
            readlink, readdir,
        } = await import('node:fs/promises');
        const directory = await mkdtemp(join(tmpdir(), 'qpdf-marked-aliases-'));
        const source = join(directory, 'source\nname.pdf');
        const error = markUnprovenNativeTermination(new Error('qpdf timeout'), 'native reader alive');
        let argsPath = '';
        runNativeToolCommandMock.mockImplementationOnce(async (_binary: string, args: string[]) => {
            argsPath = args[0]!.slice(1); throw error;
        });
        try {
            await writeFile(source, 'source');
            const {runQpdfCommand} = await import('@electron/features/page-ops/main/qpdf');
            await expect(runQpdfCommand([
                source,
                '--pages',
                source,
                '1',
                '--',
                join(directory, 'out.pdf'),
            ], {commandLabel: 'qpdf(marked)'})).rejects.toBe(error);
            expect(await readdir(dirname(argsPath))).toEqual(expect.arrayContaining([
                'args.txt',
                'path-0.pdf',
            ]));
            expect(await readlink(join(dirname(argsPath), 'path-0.pdf'))).toBe(source);
            expect(await readFile(source, 'utf8')).toBe('source');
        } finally {
            if (argsPath) await rm(dirname(argsPath), {
                recursive: true,
                force: true,
            });
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});
