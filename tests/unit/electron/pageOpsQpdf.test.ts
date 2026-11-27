import {describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {runQpdfCommand} from '@electron/features/page-ops/main/qpdf';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';

describe.runIf(process.platform !== 'win32')('desktop qpdf WASM virtual path seam', () => {
    it.each(['lf-with-sibling', 'lf-without-sibling', 'cr', 'crlf', 'output-lf', 'symlink', 'relative'] as const)(
        'selects the exact source and writes through virtual host mounts without symlink aliases: %s',
        async (scenario) => {
            const directory = await mkdtemp(join(tmpdir(), 'qpdf-path-bytes-'));
            const sentinel = 'EXACT_SOURCE_SENTINEL';
            async function fixture(path: string, count: number, word: string) {
                const document = await PDFDocument.create();
                const font = await document.embedFont(StandardFonts.Helvetica);
                for (let i = 0; i < count; i++) {
                    document.addPage().drawText(word, {font});
                }
                await writeFile(path, await document.save());
            }
            const separator = scenario === 'cr' ? '\r' : scenario === 'crlf' ? '\r\n' : '\n';
            const source = join(directory, `source${separator}name.pdf`);
            const output = join(directory, scenario === 'output-lf' ? 'output\nname.pdf' : 'output.pdf');
            await fixture(source, 1, sentinel);
            if (scenario === 'lf-with-sibling') {
                await fixture(join(directory, 'source name.pdf'), 2, 'WRONG_SPACE_SIBLING');
            }
            let operand = source;
            if (scenario === 'symlink') {
                operand = join(directory, 'link\nsource.pdf');
                await symlink(source, operand);
            }
            if (scenario === 'relative') {
                operand = `source${separator}name.pdf`;
            }
            try {
                await runQpdfCommand([operand, '--pages', operand, '1-z', '--', output], {
                    commandLabel: 'qpdf(path-regression)',
                    ...(scenario === 'relative' ? {cwd: directory} : {}),
                });
                const reopened = await PDFDocument.load(await readFile(output));
                expect(reopened.getPageCount()).toBe(1);
                const pages = await runDesktopQpdfWasm(['--show-pages', output]);
                const content = /content:\s+(\d+) (\d+) R/u.exec(pages.stdout);
                expect(content).not.toBeNull();
                const stream = await runDesktopQpdfWasm([`--show-object=${content![1]},${content![2]}`, '--filtered-stream-data', output]);
                expect(stream.stdout.toUpperCase()).toContain(Buffer.from(sentinel).toString('hex').toUpperCase());
                expect(existsSync(join(directory, 'output name.pdf'))).toBe(false);
            } finally {
                await rm(directory, {
                    recursive: true,
                    force: true,
                });
            }
        },
    );
});
