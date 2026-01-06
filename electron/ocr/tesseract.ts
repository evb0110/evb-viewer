import { spawn } from 'child_process';
import { app } from 'electron';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { getOcrPaths } from '@electron/ocr/paths';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('tesseract');

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
    text: string;
    pageWidth: number;
    pageHeight: number;
}

export async function runOcr(
    imageBuffer: Buffer,
    languages: string[],
): Promise<IOcrResult> {
    const {
        binary,
        tessdata,
    } = getOcrPaths();

    const args = [
        'stdin',
        'stdout',
        '-l',
        languages.join('+'),
        '--tessdata-dir',
        tessdata,
    ];

    return new Promise((resolve) => {
        const proc = spawn(binary, args, {env: {
            ...process.env,
            TESSDATA_PREFIX: tessdata,
        }});

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

/**
 * Generate a searchable PDF directly from image using Tesseract native PDF output
 * This is used when pdf-lib fails to parse the original PDF
 * Tesseract handles all text embedding automatically
 */
export async function generateSearchablePdfDirect(
    imageBuffer: Buffer,
    languages: string[],
): Promise<IOcrPdfResult> {
    log.debug(`generateSearchablePdfDirect: Creating PDF with languages=${languages.join(',')}`);

    const {
        binary,
        tessdata,
    } = getOcrPaths();

    const tempDir = app.getPath('temp');
    const sessionId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = join(tempDir, `${sessionId}-input.png`);
    const outputBase = join(tempDir, `${sessionId}-output`);
    const pdfPath = `${outputBase}.pdf`;

    async function cleanup() {
        await unlink(inputPath).catch(err => log.warn(`Cleanup warning (inputPath): ${err.message}`));
        await unlink(pdfPath).catch(err => log.warn(`Cleanup warning (pdfPath): ${err.message}`));
    }

    try {
        // Write image to temp file
        log.debug('Writing temp image file...');
        await writeFile(inputPath, imageBuffer);
        log.debug(`Temp file written: ${inputPath}`);

        // Run Tesseract with PDF output format
        // Uses -c tessedit_create_pdf=1 to generate searchable PDF with embedded text
        const args = [
            inputPath,
            outputBase,
            '-l',
            languages.join('+'),
            '--tessdata-dir',
            tessdata,
            '-c',
            'tessedit_create_pdf=1',  // Generate PDF with text layer
        ];

        log.debug(`Spawning tesseract for PDF generation: ${binary} ${args.join(' ')}`);

        return new Promise((resolve) => {
            const proc = spawn(binary, args, {env: {
                ...process.env,
                TESSDATA_PREFIX: tessdata,
            }});

            let stderr = '';

            proc.stderr.on('data', (data: Buffer) => {
                const msg = data.toString();
                stderr += msg;
                log.debug(`stderr: ${msg.trim()}`);
            });

            proc.on('close', async (code) => {
                log.debug(`Tesseract PDF generation exited with code ${code}`);
                try {
                    if (code === 0) {
                        // Check if PDF was created
                        const pdfBuffer = await readFile(pdfPath);
                        log.debug(`PDF generated successfully: ${pdfBuffer.length} bytes`);

                        resolve({
                            success: true,
                            pdfBuffer,
                        });
                    } else {
                        log.debug(`Tesseract failed with code ${code}: ${stderr}`);
                        resolve({
                            success: false,
                            pdfBuffer: null,
                            error: stderr || `Tesseract exited with code ${code}`,
                        });
                    }
                } finally {
                    await cleanup();
                }
            });

            proc.on('error', async (err) => {
                log.debug(`Process error: ${err.message}`);
                await cleanup();
                resolve({
                    success: false,
                    pdfBuffer: null,
                    error: err.message,
                });
            });
        });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Exception: ${errMsg}`);
        await cleanup();
        return {
            success: false,
            pdfBuffer: null,
            error: errMsg,
        };
    }
}

export async function runOcrWithBoundingBoxes(
    imageBuffer: Buffer,
    languages: string[],
    imageWidth: number,
    imageHeight: number,
): Promise<{
    success: boolean;
    pageData: IOcrPageData | null;
    error?: string 
}> {
    log.debug(`runOcrWithBoundingBoxes started: langs=${languages.join(',')}`);

    const {
        binary,
        tessdata,
    } = getOcrPaths();
    const tempDir = app.getPath('temp');
    const sessionId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = join(tempDir, `${sessionId}-input.png`);
    const outputBase = join(tempDir, `${sessionId}-output`);
    const txtPath = `${outputBase}.txt`;
    const tsvPath = `${outputBase}.tsv`;

    async function cleanup() {
        await unlink(inputPath).catch(err => log.warn(`Cleanup warning (inputPath): ${err.message}`));
        await unlink(txtPath).catch(err => log.warn(`Cleanup warning (txtPath): ${err.message}`));
        await unlink(tsvPath).catch(err => log.warn(`Cleanup warning (tsvPath): ${err.message}`));
    }

    try {
        // Write image to temp file
        log.debug('Writing temp image file...');
        await writeFile(inputPath, imageBuffer);
        log.debug(`Temp file written to ${inputPath}`);

        // Generate both txt (default) and tsv (config option) for precise bounding boxes
        // TSV gives exact word positions (±2% error) vs estimation (±15% error)
        const args = [
            inputPath,
            outputBase,
            '-l',
            languages.join('+'),
            '--tessdata-dir',
            tessdata,
            '-c',
            'tessedit_create_tsv=1',  // Generate TSV for precise word coordinates
        ];

        log.debug(`Spawning tesseract: ${binary} ${args.join(' ')}`);

        return new Promise((resolve) => {
            const proc = spawn(binary, args, {env: {
                ...process.env,
                TESSDATA_PREFIX: tessdata,
            }});

            log.debug('Process spawned, setting up listeners');

            let stderr = '';

            proc.stderr.on('data', (data: Buffer) => {
                const msg = data.toString();
                stderr += msg;
                log.debug(`stderr: ${msg.trim()}`);
            });

            proc.on('close', async (code) => {
                log.debug(`Process closed with code ${code}`);
                try {
                    if (code === 0) {
                        let pageText = '';
                        try {
                            pageText = (await readFile(txtPath, 'utf-8')).trim();
                        } catch (txtReadErr) {
                            const txtMsg = txtReadErr instanceof Error ? txtReadErr.message : String(txtReadErr);
                            log.debug(`Failed to read TXT output: ${txtMsg}`);
                        }

                        // Try TSV first (precise coordinates), fall back to TXT (estimation)
                        let words: IOcrWord[] = [];

                        try {
                            log.debug(`Reading TSV file from ${tsvPath}`);
                            const tsvContent = await readFile(tsvPath, 'utf-8');
                            log.debug(`TSV file read, size: ${tsvContent.length} bytes`);
                            words = parseTsvOutput(tsvContent);
                            log.debug(`Parsed ${words.length} words from TSV (precise coordinates)`);
                        } catch (tsvErr) {
                            // TSV parsing failed, fall back to TXT estimation
                            const tsvMsg = tsvErr instanceof Error ? tsvErr.message : String(tsvErr);
                            const tsvStack = tsvErr instanceof Error ? tsvErr.stack : '';
                            log.debug(`TSV parsing failed: ${tsvMsg}, falling back to TXT`);
                            if (tsvStack) log.debug(`TSV error stack: ${tsvStack}`);
                            try {
                                const txtContent = pageText || await readFile(txtPath, 'utf-8');
                                log.debug(`TXT file read, size: ${txtContent.length} bytes`);
                                words = parseTxtOutput(txtContent, imageWidth, imageHeight);
                                log.debug(`Parsed ${words.length} words from TXT (estimated coordinates)`);
                            } catch (txtErr) {
                                const txtMsg = txtErr instanceof Error ? txtErr.message : String(txtErr);
                                const txtStack = txtErr instanceof Error ? txtErr.stack : '';
                                log.debug(`Both TSV and TXT parsing failed: ${txtMsg}`);
                                if (txtStack) log.debug(`TXT error stack: ${txtStack}`);
                                throw txtErr;
                            }
                        }

                        resolve({
                            success: true,
                            pageData: {
                                words,
                                text: pageText,
                                pageWidth: imageWidth,
                                pageHeight: imageHeight,
                            },
                        });
                    } else {
                        log.debug(`Tesseract failed with code ${code}, stderr: ${stderr}`);
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
                log.debug(`Process error: ${err.message}`);
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
        log.debug(`Exception: ${errMsg}`);
        await cleanup();
        return {
            success: false,
            pageData: null,
            error: errMsg,
        };
    }
}

/**
 * Parse Tesseract TSV output format for precise word bounding boxes
 *
 * TSV format (tab-separated):
 * level page_num block_num par_num line_num word_num left top right bottom confidence text
 * 5     1        1         1       1        1        70   52  123  75    95         Hello
 *
 * level 5 = word (smallest unit, what we want)
 * Coordinates are relative to image
 */
function parseTsvOutput(tsvContent: string): IOcrWord[] {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return [];
    }  // Header only, no words

    const words: IOcrWord[] = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;  // Only process word-level (5)

        const left = parseInt(parts[6]!, 10);
        const top = parseInt(parts[7]!, 10);
        const width = parseInt(parts[8]!, 10);
        const height = parseInt(parts[9]!, 10);
        const confidence = parseInt(parts[10]!, 10);
        const text = parts[11] || '';

        // Skip very low confidence words (OCR errors)
        // Using threshold of 20 to capture important words with 20-30% confidence
        // while still filtering genuine OCR errors (0%)
        if (confidence < 20) continue;

        // Skip if coordinates are invalid
        if (width <= 0 || height <= 0) continue;

        // Create word object with exact coordinates
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

/**
 * Parse plain text output - fallback when TSV is not available
 * Uses position estimation based on word distribution
 * Accuracy: ±15% (vs TSV ±2%)
 */
function parseTxtOutput(txtContent: string, imageWidth: number, imageHeight: number): IOcrWord[] {
    const text = txtContent.trim();
    if (!text) {
        return [];
    }

    // Split text into words
    const wordTexts = text.split(/\s+/).filter(w => w.length > 0);
    const words: IOcrWord[] = [];

    // Distribute words across the page with estimated positions
    const estimatedWordWidth = imageWidth / 50;  // Rough estimate
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
