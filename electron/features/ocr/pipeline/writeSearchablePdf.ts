import {
    open,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    buildOcrTextLayerPageInstruction,
    type IOcrRecognizedPage,
} from '@ocr-core/recognizeOcrPages';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';

const STREAM_WRITE_BUFFER_CHARS = 64 * 1024;

/**
 * Streams recognized page checkpoints into the JSON instructions sidecar one
 * page at a time (without retaining all page records or serialized JSON in JS
 * memory) and runs pdf-page-ops to write the searchable layer as incremental
 * revisions of the source PDF.
 */
export async function writeSearchablePdf(input: {
    pdfPageOpsBinary: string;
    sourcePdfPath: string;
    pages: AsyncIterable<{
        pdfPath: string;
        page: Omit<IOcrRecognizedPage, 'pdf'>;
    }>;
    tempDir: string;
    sessionId: string;
    signal: AbortSignal;
}) {
    const instructionsPath = join(input.tempDir, `${input.sessionId}-text-layer.json`);
    const outputPath = join(input.tempDir, `${input.sessionId}-merged.pdf`);
    let pageCount = 0;

    try {
        input.signal.throwIfAborted();
        const handle = await open(instructionsPath, 'w');
        try {
            let buffered = '{"pages":[';
            const flush = async () => {
                if (buffered.length === 0) {return;}
                const chunk = Buffer.from(buffered, 'utf8');
                buffered = '';
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const {bytesWritten} = await handle.write(chunk, offset, chunk.byteLength - offset);
                    if (bytesWritten <= 0) {
                        throw new Error(`Short write while staging OCR instructions: ${instructionsPath}`);
                    }
                    offset += bytesWritten;
                }
            };

            for await (const checkpoint of input.pages) {
                input.signal.throwIfAborted();
                const serialized = JSON.stringify(buildOcrTextLayerPageInstruction(checkpoint.page, checkpoint.pdfPath));
                buffered += pageCount === 0 ? serialized : `,${serialized}`;
                pageCount += 1;
                if (buffered.length >= STREAM_WRITE_BUFFER_CHARS) {
                    await flush();
                }
            }

            if (pageCount === 0) {
                throw new Error('No recognized OCR pages were available to write');
            }
            buffered += ']}';
            await flush();
        } finally {
            await handle.close();
        }

        input.signal.throwIfAborted();
        await runNativeToolCommand(input.pdfPageOpsBinary, [
            'ocr-text-layer',
            '--input',
            input.sourcePdfPath,
            '--output',
            outputPath,
            '--instructions-file',
            instructionsPath,
        ], {
            commandLabel: 'evb-pdf-page-ops(ocr-text-layer)',
            signal: input.signal,
        });
        return outputPath;
    } catch (error) {
        await rm(outputPath, {force: true}).catch(() => undefined);
        throw error;
    } finally {
        await rm(instructionsPath, {force: true}).catch(() => undefined);
    }
}
