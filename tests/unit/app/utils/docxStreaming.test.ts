import {
    describe,
    expect,
    it,
} from 'vitest';
import {createDocxFromTextAsync} from '@app/utils/docx';
import {
    createDocxFromTextChunks,
    resolveDocxParagraphDirection,
} from '@app/utils/docxStreaming';

describe('createDocxFromTextAsync', () => {
    it('builds a DOCX package while checking the caller signal', async () => {
        const controller = new AbortController();
        const output = await createDocxFromTextAsync('catalog text', false, controller.signal);

        expect(output.byteLength).toBeGreaterThan(0);
        expect(new TextDecoder().decode(output.slice(0, 2))).toBe('PK');
    });

    it('preserves mixed paragraph direction in the async builder', async () => {
        const output = await createDocxFromTextAsync('אבג 123\nLatin 456\n123');
        const xml = new TextDecoder().decode(output);

        expect(xml).toContain('<w:p><w:pPr><w:bidi/></w:pPr>');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">Latin 456');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">123');
    });

    it('rejects before building when its signal is already canceled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(createDocxFromTextAsync('catalog text', false, controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });
});

describe('createDocxFromTextChunks', () => {
    it('keeps paragraph direction local to mixed text and leaves numeric paragraphs neutral', async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of createDocxFromTextChunks(['אבג 123\nLatin 456\n123'])) {
            chunks.push(chunk);
        }
        const xml = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
        expect(xml).toContain('<w:p><w:pPr><w:bidi/></w:pPr>');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">Latin 456');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">123');
    });

    it('uses an RTL language hint only when text has no detected strong direction', () => {
        expect(resolveDocxParagraphDirection('123', true)).toBe(false);
        expect(resolveDocxParagraphDirection('漢字', true)).toBe(true);
        expect(resolveDocxParagraphDirection('Latin', true)).toBe(false);
    });

    it('rejects before producing output when its signal is already canceled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        const stream = createDocxFromTextChunks(['text'], false, controller.signal);

        await expect(stream.next()).rejects.toMatchObject({name: 'AbortError'});
    });

    it('stops between bounded output chunks when its signal is canceled', async () => {
        const controller = new AbortController();
        const stream = createDocxFromTextChunks(['text'], false, controller.signal);

        await expect(stream.next()).resolves.toMatchObject({done: false});
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(stream.next()).rejects.toMatchObject({name: 'AbortError'});
    });
});
