import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/features/djvu/main/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'})}));
vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));

const {
    addDjvuMatchGeometry,
    createDjvuTextSExpressionParser,
    detectDjvuHasText,
} = await import('@electron/features/djvu/main/textSearch');

interface IRunOptions {
    onStdout?: (chunk: string) => void;
    signal?: AbortSignal;
}

function nativeResult() {
    return {
        command: '/tools/djvused',
        args: [],
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
    };
}

function abortError() {
    return new DOMException('Operation aborted', 'AbortError');
}

function streamOutput(output: string, chunkLength = 7) {
    mocks.runNativeCommand.mockImplementation(async (
        _command: string,
        _args: string[],
        options: IRunOptions,
    ) => {
        for (let offset = 0; offset < output.length; offset += chunkLength) {
            options.onStdout?.(output.slice(offset, offset + chunkLength));
            if (options.signal?.aborted) {
                throw abortError();
            }
        }
        return nativeResult();
    });
}

describe('DjVu native streamed text search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses arbitrarily split text output and maps word boxes into top-left page coordinates', () => {
        const pages: Array<{
            pageNumber: number;
            text: string;
            zones: Array<{word?: {
                x: number;
                y: number;
                width: number;
                height: number
            } | undefined}>;
        }> = [];
        const parser = createDjvuTextSExpressionParser({onPage(page) {
            pages.push(page);
            return undefined;
        }});
        const output = '(page 0 0 1000 2000 (line 10 1500 900 1600 '
            + '(word 10 1500 120 1600 "Late") '
            + '(word 140 1500 360 1600 "needle\\040box")))';

        for (let offset = 0; offset < output.length; offset += 3) {
            parser.push(output.slice(offset, offset + 3));
        }

        expect(parser.finish()).toBe(1);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.text).toBe('Late needle box');
        expect(pages[0]?.zones[0]?.word).toEqual({
            text: 'Late',
            x: 10,
            y: 400,
            width: 110,
            height: 100,
        });
    });

    it('decodes octal-escaped UTF-8 without damaging ordinary escapes or code points', () => {
        const pages: Array<{text: string}> = [];
        const parser = createDjvuTextSExpressionParser({onPage(page) {
            pages.push(page);
            return undefined;
        }});
        const output = '(page 0 0 1000 2000 (line 0 0 1000 100 '
            + '(word 0 0 100 100 "\\320\\237\\321\\200\\320\\265\\320\\264\\320\\270\\321\\201\\320\\273\\320\\276\\320\\262\\320\\270\\320\\265") '
            + '(word 110 0 300 100 "line\\nbreak") '
            + '(word 310 0 500 100 "Syriac ܐܪܡܝܐ 📖")))';

        for (let offset = 0; offset < output.length; offset += 5) {
            parser.push(output.slice(offset, offset + 5));
        }

        expect(parser.finish()).toBe(1);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.text).toBe('Предисловие line\nbreak Syriac ܐܪܡܝܐ 📖');
    });

    it('attaches the word boxes of a match from its page text zones', async () => {
        streamOutput([
            '(page 0 0 1000 2000 (line 10 1500 900 1600',
            ' (word 10 1500 130 1600 "Late")',
            ' (word 150 1500 350 1600 "Needle")))',
        ].join('\n'), 5);

        const results = await addDjvuMatchGeometry('/library/book.djvu', [{
            pageNumber: requirePageNumber(2),
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 5,
            endOffset: 11,
            excerpt: {
                prefix: false,
                suffix: false,
                before: 'Late ',
                match: 'Needle',
                after: '',
            },
        }]);

        expect(mocks.runNativeCommand.mock.calls[0]?.[1]).toEqual([
            '/library/book.djvu',
            '-e',
            'select 2; print-txt',
        ]);
        expect(results).toMatchObject([{
            pageNumber: 2,
            pageWidth: 1000,
            pageHeight: 2000,
            words: [{
                text: 'Needle',
                x: 150,
                y: 400,
                width: 200,
                height: 100,
            }],
        }]);
    });

    it('treats empty page syntax as empty and detects actual text on later pages', async () => {
        streamOutput([
            '(page 0 0 1000 2000 "")',
            '(page 0 0 1000 2000 (line 10 1500 900 1600',
            ' (word 10 1500 130 1600 "Found")))',
            '(page 0 0 1000 2000 "")',
        ].join('\n'), 11);

        await expect(detectDjvuHasText('/library/book.djvu')).resolves.toBe(true);
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);

        streamOutput('(page 0 0 1000 2000 "")\n(page 0 0 1000 2000 "")');
        await expect(detectDjvuHasText('/library/empty.djvu')).resolves.toBe(false);
    });
});
