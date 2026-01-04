import { spawn } from 'child_process';
import { app } from 'electron';
import {
    appendFileSync,
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { appendFileSync as appendSync } from 'fs';
import { join } from 'path';
import { getOcrPaths } from './paths';

const LOG_FILE = join(app.getPath('temp'), 'ocr-debug.log');

function debugLog(msg: string) {
    const ts = new Date().toISOString();
    appendSync(LOG_FILE, `[${ts}] [tesseract] ${msg}\n`);
}

interface IOcrResult {
    success: boolean;
    text: string;
    error?: string;
}

interface IOcrPdfResult {
    success: boolean;
    pdfBuffer: Buffer | null;
    error?: string;
}

interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IOcrPageData {
    words: IOcrWord[];
    pageWidth: number;
    pageHeight: number;
}

export async function runOcr(
    imageBuffer: Buffer,
    languages: string[],
): Promise<IOcrResult> {
    const { binary, tessdata } = getOcrPaths();

    const args = [
        'stdin',
        'stdout',
        '-l', languages.join('+'),
        '--tessdata-dir', tessdata,
    ];

    return new Promise((resolve) => {
        const proc = spawn(binary, args, {
            env: {
                ...process.env,
                TESSDATA_PREFIX: tessdata,
            },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve({
                    success: true,
                    text: stdout.trim(),
                });
            } else {
                resolve({
                    success: false,
                    text: '',
                    error: stderr || `Tesseract exited with code ${code}`,
                });
            }
        });

        proc.on('error', (err) => {
            resolve({
                success: false,
                text: '',
                error: err.message,
            });
        });

        // Write image data to stdin and close
        proc.stdin.write(imageBuffer);
        proc.stdin.end();
    });
}

export async function runOcrWithBoundingBoxes(
    imageBuffer: Buffer,
    languages: string[],
    imageDpi: number,
    imageWidth: number,
    imageHeight: number,
): Promise<{ success: boolean; pageData: IOcrPageData | null; error?: string }> {
    debugLog(`runOcrWithBoundingBoxes started: langs=${languages.join(',')}, dpi=${imageDpi}`);

    const { binary, tessdata } = getOcrPaths();
    const tempDir = app.getPath('temp');
    const sessionId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = join(tempDir, `${sessionId}-input.png`);
    const outputBase = join(tempDir, `${sessionId}-output`);
    const txtPath = `${outputBase}.txt`;

    async function cleanup() {
        await unlink(inputPath).catch(() => {});
        await unlink(txtPath).catch(() => {});
    }

    try {
        // Write image to temp file
        debugLog('Writing temp image file...');
        await writeFile(inputPath, imageBuffer);
        debugLog(`Temp file written to ${inputPath}`);

        const args = [
            inputPath,
            outputBase,
            '-l', languages.join('+'),
            '--tessdata-dir', tessdata,
        ];

        debugLog(`Spawning tesseract: ${binary} ${args.join(' ')}`);

        return new Promise((resolve) => {
            const proc = spawn(binary, args, {
                env: {
                    ...process.env,
                    TESSDATA_PREFIX: tessdata,
                },
            });

            debugLog('Process spawned, setting up listeners');

            let stderr = '';

            proc.stderr.on('data', (data: Buffer) => {
                const msg = data.toString();
                stderr += msg;
                debugLog(`stderr: ${msg.trim()}`);
            });

            proc.on('close', async (code) => {
                debugLog(`Process closed with code ${code}`);
                try {
                    if (code === 0) {
                        debugLog(`Reading TXT file from ${txtPath}`);
                        const txtContent = await readFile(txtPath, 'utf-8');
                        debugLog(`TXT file read, size: ${txtContent.length} bytes`);
                        const words = parseTxtOutput(txtContent, imageWidth, imageHeight);
                        debugLog(`Parsed ${words.length} words from TXT`);
                        resolve({
                            success: true,
                            pageData: {
                                words,
                                pageWidth: imageWidth,
                                pageHeight: imageHeight,
                            },
                        });
                    } else {
                        debugLog(`Tesseract failed with code ${code}, stderr: ${stderr}`);
                        resolve({
                            success: false,
                            pageData: null,
                            error: stderr || `Tesseract exited with code ${code}`,
                        });
                    }
                } finally {
                    await cleanup();
                }
            });

            proc.on('error', async (err) => {
                debugLog(`Process error: ${err.message}`);
                await cleanup();
                resolve({
                    success: false,
                    pageData: null,
                    error: err.message,
                });
            });
        });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Exception: ${errMsg}`);
        await cleanup();
        return {
            success: false,
            pageData: null,
            error: errMsg,
        };
    }
}

function parseTxtOutput(txtContent: string, imageWidth: number, imageHeight: number): IOcrWord[] {
    const text = txtContent.trim();
    if (!text) return [];

    // Split text into words
    const wordTexts = text.split(/\s+/).filter(w => w.length > 0);
    const words: IOcrWord[] = [];

    // Distribute words across the page with estimated positions
    // Calculate approximate word width based on average word length
    const avgCharsPerWord = 5;
    const estimatedWordWidth = (imageWidth / 50);  // Rough estimate
    const lineHeight = Math.max(20, imageHeight / 20);  // Estimate line height

    let x = 50;
    let y = 50;
    let wordsInLine = 0;
    const wordsPerLine = Math.max(3, Math.floor(imageWidth / estimatedWordWidth));

    for (const wordText of wordTexts) {
        if (wordsInLine >= wordsPerLine) {
            x = 50;
            y += lineHeight;
            wordsInLine = 0;
        }

        words.push({
            text: wordText,
            x: Math.max(0, x),
            y: Math.max(0, y),
            width: estimatedWordWidth,
            height: lineHeight * 0.7,  // Slightly smaller than line height
        });

        x += estimatedWordWidth + 10;  // Space between words
        wordsInLine++;
    }

    return words;
}
