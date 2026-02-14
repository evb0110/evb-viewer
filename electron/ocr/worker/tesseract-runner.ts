import { spawn } from 'child_process';
import {
    readFile,
    stat,
    unlink,
} from 'fs/promises';
import type { IOcrWord } from '../../../app/types/shared';
import type { IOcrFileResult } from '@electron/ocr/worker/types';
import { resolveTesseractLanguageConfig } from '@electron/ocr/tesseract-language-config';

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

export function getPngDimensions(imageBuffer: Buffer): {
    width: number;
    height: number;
} | null {
    if (imageBuffer.length < 24) {
        return null;
    }
    if (!imageBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }
    const width = imageBuffer.readUInt32BE(16);
    const height = imageBuffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
        return null;
    }
    return {
        width,
        height,
    };
}

function buildTesseractEnv(tessdataPath: string, threads?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        TESSDATA_PREFIX: tessdataPath,
    };
    if (typeof threads === 'number' && Number.isFinite(threads) && threads > 0) {
        env.OMP_THREAD_LIMIT = String(Math.floor(threads));
        env.OMP_NUM_THREADS = String(Math.floor(threads));
    }
    return env;
}

export async function runOcrFileBased(
    imagePath: string,
    languages: string[],
    imageWidth: number,
    imageHeight: number,
    extractionDpi: number,
    tesseractBinary: string,
    tessdataPath: string,
    threads?: number,
): Promise<IOcrFileResult> {
    const outputBase = imagePath.replace(/\.png$/, '') + '-ocr';
    const languageConfig = resolveTesseractLanguageConfig(languages);

    const args = [
        imagePath,
        outputBase,
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        tessdataPath,
        '--dpi',
        String(extractionDpi),
        ...languageConfig.extraConfigArgs,
        '-c',
        'tessedit_create_tsv=1',
        '-c',
        'tessedit_create_pdf=1',
        '-c',
        'textonly_pdf=1',
    ];

    return new Promise((resolve) => {
        const proc = spawn(tesseractBinary, args, { env: buildTesseractEnv(tessdataPath, threads) });

        let stderr = '';

        proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', async (code) => {
            if (code !== 0) {
                resolve({
                    success: false,
                    pageData: null,
                    pdfPath: null,
                    error: stderr || `Tesseract exited with code ${code}`,
                });
                return;
            }

            try {
                const tsvPath = `${outputBase}.tsv`;
                const tsvContent = await readFile(tsvPath, 'utf-8');
                const words = parseTsvOutput(tsvContent.trim());
                let pageText = parseTsvText(tsvContent.trim());

                if (languages.includes('ell')) {
                    for (const word of words) {
                        word.text = word.text.replace(/\u00B5/g, '\u03BC');
                    }
                    pageText = pageText.replace(/\u00B5/g, '\u03BC');
                }

                const pdfPath = `${outputBase}.pdf`;
                try {
                    await stat(pdfPath);
                } catch {
                    resolve({
                        success: false,
                        pageData: null,
                        pdfPath: null,
                        error: 'Tesseract did not produce PDF output',
                    });
                    return;
                }

                try {
                    await unlink(tsvPath);
                } catch {
                    // Ignore cleanup errors
                }

                resolve({
                    success: true,
                    pageData: {
                        pageNumber: 0,
                        words,
                        text: pageText,
                        imageWidth,
                        imageHeight,
                    },
                    pdfPath,
                });
            } catch (parseErr) {
                const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                resolve({
                    success: false,
                    pageData: null,
                    pdfPath: null,
                    error: parseMsg,
                });
            }
        });

        proc.on('error', (err) => {
            resolve({
                success: false,
                pageData: null,
                pdfPath: null,
                error: err.message,
            });
        });
    });
}

function parseTsvOutput(tsvContent: string): IOcrWord[] {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return [];
    }

    const words: IOcrWord[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;

        const left = parseInt(parts[6]!, 10);
        const top = parseInt(parts[7]!, 10);
        const width = parseInt(parts[8]!, 10);
        const height = parseInt(parts[9]!, 10);
        const confidence = parseInt(parts[10]!, 10);
        const text = parts[11] || '';

        if (confidence < 20) continue;
        if (width <= 0 || height <= 0) continue;

        words.push({
            text: text.trim(),
            x: left,
            y: top,
            width,
            height,
        });
    }

    return words;
}

function parseTsvText(tsvContent: string): string {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return '';
    }

    const outputLines: string[] = [];
    let currentLineKey: string | null = null;
    let currentWords: string[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;

        const blockNum = parts[2] || '0';
        const parNum = parts[3] || '0';
        const lineNum = parts[4] || '0';
        const lineKey = `${blockNum}-${parNum}-${lineNum}`;

        const text = (parts[11] || '').trim();
        if (!text) continue;

        if (currentLineKey !== null && lineKey !== currentLineKey) {
            if (currentWords.length > 0) {
                outputLines.push(currentWords.join(' '));
            }
            currentWords = [];
        }

        currentLineKey = lineKey;
        currentWords.push(text);
    }

    if (currentWords.length > 0) {
        outputLines.push(currentWords.join(' '));
    }

    return outputLines.join('\n').trim();
}
