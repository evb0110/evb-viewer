import {createPdfCombineProgressHandler} from '@evb/scan-cleanup/core/createPdfCombineProgressHandler';
import {describe, expect, it, vi} from 'vitest';

describe('createPdfCombineProgressHandler', () => {
    it('parses chunked NDJSON progress frames using the shared combine progress contract', () => {
        const processedCalls: Array<[number, number]> = [];
        const malformedLines: string[] = [];
        const onStdout = createPdfCombineProgressHandler(
            4,
            (processed, total) => processedCalls.push([processed, total]),
            (line) => malformedLines.push(line),
        );

        onStdout('{"type":"progress","processed":1,"total":4,"percent":25,');
        onStdout('"elapsedMs":12,"estimatedRemainingMs":36}\r\n\n');
        onStdout('{"type":"progress","processed":4,"total":4,"percent":100,"elapsedMs":40}\n');

        expect(processedCalls).toEqual([
            [1, 4],
            [4, 4],
        ]);
        expect(malformedLines).toEqual([]);
    });

    it('preserves the total === 0 fallback and clamps processed to total', () => {
        const processedCalls: Array<[number, number]> = [];
        const onStdout = createPdfCombineProgressHandler(5, (processed, total) => processedCalls.push([processed, total]));

        onStdout('{"type":"progress","processed":3,"total":0,"percent":60,"elapsedMs":10}\n');
        onStdout('{"type":"progress","processed":9,"total":0,"percent":100,"elapsedMs":20}\n');

        expect(processedCalls).toEqual([
            [3, 5],
            [5, 5],
        ]);

        const zeroPageCalls: Array<[number, number]> = [];
        const onZeroPages = createPdfCombineProgressHandler(0, (processed, total) => zeroPageCalls.push([processed, total]));
        onZeroPages('{"type":"progress","processed":2,"total":0,"percent":100,"elapsedMs":1}\n');
        expect(zeroPageCalls).toEqual([[1, 1]]);
    });

    it('reports invalid JSON and schema-invalid payloads to onMalformedLine without calling onProcessed', () => {
        const onProcessed = vi.fn();
        const malformedLines: string[] = [];
        const onStdout = createPdfCombineProgressHandler(4, onProcessed, (line) => malformedLines.push(line));

        const badLines = [
            '{not-json',
            'null',
            '{"processed":1,"total":4}',
            '{"type":"other","processed":1,"total":4,"percent":25,"elapsedMs":1}',
            '{"type":"progress","processed":-1,"total":4,"percent":0,"elapsedMs":1}',
            '{"type":"progress","processed":1,"total":4,"percent":101,"elapsedMs":1}',
            '{"type":"progress","processed":1,"total":4,"percent":25,"elapsedMs":-5}',
        ];
        onStdout(`${badLines.join('\n')}\n`);

        expect(onProcessed).not.toHaveBeenCalled();
        expect(malformedLines).toEqual(badLines);
    });

    it('keeps decode failures separate from onProcessed callback throws', () => {
        const malformed = vi.fn();
        const onStdout = createPdfCombineProgressHandler(
            2,
            () => {
                throw new Error('downstream progress consumer failed');
            },
            malformed,
        );

        expect(() => {
            onStdout('{"type":"progress","processed":1,"total":2,"percent":50,"elapsedMs":5}\n');
        }).toThrow('downstream progress consumer failed');
        expect(malformed).not.toHaveBeenCalled();
    });
});
