import type * as TBuildDjvuRuntimeEnvModule from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import type * as TNativeRunCommandModule from '@electron/native-tools/runNativeCommand';
import type {IRunCommandOptions} from '@electron/native-tools/runNativeCommand';
import type * as TDjvuNativeToolPathsModule from '@electron/features/djvu/main/nativeToolPaths';
import {resolve} from 'node:path';
import {NativeProcessError} from '@electron/native-tools/processResult';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/features/djvu/main/nativeToolPaths', async importOriginal => ({
    ...await importOriginal<typeof TDjvuNativeToolPathsModule>(),
    getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'}),
}));
vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));

const {
    addDjvuMatchGeometry,
    createDjvuTextSExpressionParser,
    detectDjvuHasText,
    djvuSearchDocument,
    readDjvuPageText,
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

    it('reads escaped quotes and Unicode-separated atoms the same at every chunk boundary', () => {
        const output = '(page 0 0 1000 2000 (line 0 0 1000 100 '
            + '(word 0 0 100　100 "say \\"hi\\"") '
            + '(word 110 0 300 100 "back\\\\slash")))';
        const parse = (chunkLength: number) => {
            const pages: unknown[] = [];
            const parser = createDjvuTextSExpressionParser({onPage(page) {
                pages.push(page);
                return undefined;
            }});
            for (let offset = 0; offset < output.length; offset += chunkLength) {
                parser.push(output.slice(offset, offset + chunkLength));
            }
            parser.finish();
            return pages;
        };

        const whole = parse(output.length);
        expect(whole).toMatchObject([{
            text: 'say "hi" back\\slash',
            zones: [
                {word: {
                    x: 0,
                    width: 100,
                    height: 100,
                }},
                {},
            ],
        }]);
        for (let chunkLength = 1; chunkLength < output.length; chunkLength += 1) {
            expect(parse(chunkLength)).toEqual(whole);
        }
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

    it('streams all 5010 empty pages without treating a redundant output capture as unreadable text', async () => {
        const {runNativeCommand} = await vi.importActual<typeof TNativeRunCommandModule>(
            '@electron/native-tools/runNativeCommand',
        );
        mocks.runNativeCommand.mockImplementation((_command: string, _args: string[], options: IRunCommandOptions) =>
            runNativeCommand(process.execPath, [
                '-e',
                'process.stdout.write(\'(page 0 0 100 100 "")\\n\'.repeat(5010))',
            ], options));

        await expect(detectDjvuHasText('/library/empty.djvu')).resolves.toBe(false);
    });

    it('detects the first nonempty zone without waiting for the rest of the page or book', async () => {
        streamOutput('(page 0 0 100 100 (line 0 0 100 100 (word 0 0 100 100 "Found")', 11);
        await expect(detectDjvuHasText('/library/book.djvu')).resolves.toBe(true);
    });

    it('keeps unproven termination visible after finding text rather than reporting a settled positive probe', async () => {
        const unproven = markUnprovenNativeTermination(abortError(), 'DjVu reader still owns its source alias');
        mocks.runNativeCommand.mockImplementation(async (_command: string, _args: string[], options: IRunOptions) => {
            options.onStdout?.('(page 0 0 100 100 "Available source text")');
            throw unproven;
        });

        await expect(detectDjvuHasText('/library/book.djvu')).rejects.toBe(unproven);
    });

    it('does not let a positive probe override governing cancellation', async () => {
        const controller = new AbortController();
        mocks.runNativeCommand.mockImplementation(async (_command: string, _args: string[], options: IRunOptions) => {
            options.onStdout?.('(page 0 0 100 100 "Available source text")');
            controller.abort();
            throw abortError();
        });

        await expect(detectDjvuHasText('/library/book.djvu', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('rejects unreadable or malformed source text rather than treating it as known empty', async () => {
        mocks.runNativeCommand.mockRejectedValueOnce(new Error('DjVu source is unreadable'));
        await expect(detectDjvuHasText('/library/book.djvu')).rejects.toThrow('DjVu source is unreadable');
        streamOutput('(page 0 0 100 100 "Incomplete');
        await expect(detectDjvuHasText('/library/book.djvu')).rejects.toThrow('Malformed or incomplete DjVu text output');
    });

    it('reads a single DjVu page via select N; print-txt matching full-stream page output under mainJobBroker', async () => {
        const pageOutputs = [
            '(page 0 0 1000 2000 (line 0 1800 500 1900 (word 0 1800 500 1900 "PageOne")))',
            '(page 0 0 1000 2000 "")',
            '(page 0 0 1000 2000 (line 0 1800 500 1900 (word 0 1800 200 1900 "Third") (word 220 1800 500 1900 "\\320\\237\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202")) (line 0 1600 500 1700 (word 0 1600 300 1700 "NextLine")))',
            '(page 0 0 1000 2000 (line 0 1800 500 1900 (word 0 1800 500 1900 "PageFour")))',
        ];
        const fullStreamPages: Array<{
            pageNumber: number;
            text: string;
        }> = [];
        const parser = createDjvuTextSExpressionParser({onPage(page) {
            fullStreamPages.push({
                pageNumber: page.pageNumber,
                text: page.text,
            });
            return undefined;
        }});
        parser.push(pageOutputs.join('\n'));
        parser.finish();

        let activeDuringCommand = -1;
        mocks.runNativeCommand.mockImplementation(async (
            _command: string,
            args: string[],
            options: IRunOptions,
        ) => {
            activeDuringCommand = mainJobBroker.getSnapshot().active;
            expect(args).toEqual([
                '/library/book.djvu',
                '-e',
                'select 3; print-txt',
            ]);
            const output = pageOutputs[2]!;
            for (let offset = 0; offset < output.length; offset += 9) {
                options.onStdout?.(output.slice(offset, offset + 9));
            }
            return nativeResult();
        });

        const text = await readDjvuPageText('/library/book.djvu', 3);
        expect(text).toBe(fullStreamPages[2]!.text);
        expect(text).toBe('Third Привет\nNextLine');
        expect(activeDuringCommand).toBe(1);
        expect(mainJobBroker.getSnapshot().active).toBe(0);
    });

    it('handles empty, out-of-range, invalid, corrupt, and aborted single-page reads identically to full-stream semantics', async () => {
        // Invalid, non-positive, or >INT32_MAX page numbers return empty without spawning djvused.
        await expect(readDjvuPageText('/library/book.djvu', 0)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', -2)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', 1.5)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', Number.NaN)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', 2_147_483_648)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', 4_294_967_297)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', Number.MAX_SAFE_INTEGER)).resolves.toBe('');
        expect(mocks.runNativeCommand).not.toHaveBeenCalled();

        // Empty text layer on a valid page returns empty string.
        streamOutput('(page 0 0 0 0 "")');
        await expect(readDjvuPageText('/library/book.djvu', 2)).resolves.toBe('');

        // Out-of-range page number reported by djvused returns empty string.
        mocks.runNativeCommand.mockRejectedValueOnce(new NativeProcessError(
            'exit-code',
            10,
            null,
            'djvused page text failed with exit code 10. *** page "99" not found',
            '',
            '*** page "99" not found\n*** (djvused.cpp:381)\n',
        ));
        await expect(readDjvuPageText('/library/book.djvu', 99)).resolves.toBe('');

        // Non-OOR djvused failure still rejects.
        mocks.runNativeCommand.mockRejectedValueOnce(new NativeProcessError(
            'exit-code',
            10,
            null,
            'djvused page text failed with exit code 10. Failed to open document',
            '',
            '*** [1-12311] Failed to open document\n',
        ));
        await expect(readDjvuPageText('/library/corrupt.djvu', 1)).rejects.toThrow('Failed to open document');

        // Malformed S-expression output still rejects.
        streamOutput('(page 0 0 100 100 "Incomplete');
        await expect(readDjvuPageText('/library/book.djvu', 1)).rejects.toThrow('Malformed or incomplete DjVu text output');

        // Aborted signal rejects with AbortError before spawning.
        const controller = new AbortController();
        controller.abort();
        await expect(readDjvuPageText('/library/book.djvu', 1, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('matches full-stream djvuSearchDocument output on a real multi-page DjVu fixture', async () => {
        const {runNativeCommand} = await vi.importActual<typeof TNativeRunCommandModule>(
            '@electron/native-tools/runNativeCommand',
        );
        const {getDjvuNativeToolPaths} = await vi.importActual<typeof TDjvuNativeToolPathsModule>(
            '@electron/features/djvu/main/nativeToolPaths',
        );
        const {buildDjvuRuntimeEnv} = await vi.importActual<typeof TBuildDjvuRuntimeEnvModule>(
            '@electron/features/djvu/main/buildDjvuRuntimeEnv',
        );
        const realDjvused = getDjvuNativeToolPaths().djvused;
        const realEnv = buildDjvuRuntimeEnv();
        const probe = await runNativeCommand(realDjvused, ['--help'], {
            env: realEnv,
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            includeProcessEnv: true,
            allowedExitCodes: [
                0,
                1,
                10,
            ],
            timeoutMs: 5_000,
        }).catch(() => null);
        if (!probe) {
            return;
        }

        const observedScripts: string[] = [];
        mocks.runNativeCommand.mockImplementation((_command: string, args: string[], options: IRunCommandOptions) => {
            observedScripts.push(args[2] ?? '');
            return runNativeCommand(realDjvused, args, {
                ...options,
                env: realEnv,
            });
        });

        const fixturePath = resolve('tests/fixtures/djvu/sources/searchable-mixed-dpi.djvu');
        const doc = await djvuSearchDocument(fixturePath);
        const streamedPages = new Map<number, string>();
        for await (const page of doc.readPages(new AbortController().signal, undefined, () => {})) {
            streamedPages.set(page.pageNumber, page.text);
        }

        const page1 = await readDjvuPageText(fixturePath, 1);
        const page2 = await readDjvuPageText(fixturePath, 2);
        const page3OutOfRange = await readDjvuPageText(fixturePath, 3);

        expect(page1).toBe(streamedPages.get(1));
        expect(page1).toBe('djvuwin');
        expect(page2).toBe(streamedPages.get(2));
        expect(page2).toBe('');
        expect(page3OutOfRange).toBe('');
        expect(observedScripts).toEqual([
            'print-txt',
            'select 1; print-txt',
            'select 2; print-txt',
            'select 3; print-txt',
        ]);
    });
});
