import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const runNativeToolCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/features/page-ops/public/nativePageOpsPath', () => ({resolveNativePageOpsPath: () => '/native/evb-pdf-page-ops'}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({qpdf: '/native/qpdf'})}));

const {normalizePdfAppendBase} = await import('@electron/pdf/pdfAppendBase');

const REPAIRABLE = JSON.stringify({
    verdict: 'repairable',
    reason: 'damaged xref',
});

describe('normalizePdfAppendBase rewrite failures', () => {
    let dir = '';
    let sourcePath = '';
    let workingPath = '';
    let rewrittenPath = '';

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pdf-append-base-'));
        sourcePath = join(dir, 'source.pdf');
        workingPath = join(dir, 'working.pdf');
        rewrittenPath = `${workingPath}.rewritten.pdf`;
        writeFileSync(sourcePath, 'damaged');
        runNativeToolCommandMock.mockReset();
    });

    afterEach(() => {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    });

    it('refuses a source qpdf cannot rewrite as an invalid PDF and leaves no rewrite leftover', async () => {
        runNativeToolCommandMock.mockImplementation(async (_binary: string, args: string[]) => {
            if (args[0] === 'append-admission') {
                return {stdout: REPAIRABLE};
            }
            writeFileSync(rewrittenPath, 'partial');
            throw new Error('qpdf: unable to recover');
        });

        await expect(normalizePdfAppendBase(sourcePath, workingPath))
            .rejects.toMatchObject({code: 'invalid-pdf'});
        expect(existsSync(rewrittenPath)).toBe(false);
        expect(existsSync(workingPath)).toBe(false);
    });

    it('refuses a rewrite that still cannot take an edit and removes it', async () => {
        runNativeToolCommandMock.mockImplementation(async (_binary: string, args: string[]) => {
            if (args[0] === 'append-admission') {
                return {stdout: REPAIRABLE};
            }
            writeFileSync(rewrittenPath, 'still damaged');
            return {stdout: ''};
        });

        await expect(normalizePdfAppendBase(sourcePath, workingPath))
            .rejects.toMatchObject({code: 'invalid-pdf'});
        expect(existsSync(rewrittenPath)).toBe(false);
        expect(existsSync(workingPath)).toBe(false);
    });
});
