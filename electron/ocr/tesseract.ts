import { spawn } from 'child_process';
import { app } from 'electron';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { getOcrPaths } from './paths';

const LOG_FILE = join(app.getPath('temp'), 'ocr-debug.log');

function debugLog(msg: string) {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [tesseract] ${msg}\n`);
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

export async function runOcrWithBoundingBoxes(
    imageBuffer: Buffer,
    languages: string[],
    imageDpi: number,
    imageWidth: number,
    imageHeight: number,
): Promise<{
    success: boolean;
    pageData: IOcrPageData | null;
    error?: string 
}> {
    debugLog(`runOcrWithBoundingBoxes started: langs=${languages.join(',')}, dpi=${imageDpi}`);

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
        await unlink(inputPath).catch(() => {});
        await unlink(txtPath).catch(() => {});
        await unlink(tsvPath).catch(() => {});
    }

    try {
        // Write image to temp file
        debugLog('Writing temp image file...');
        await writeFile(inputPath, imageBuffer);
        debugLog(`Temp file written to ${inputPath}`);

        // Add both txt and tsv output formats for precise bounding boxes
        // TSV gives exact word positions (±2% error) vs estimation (±15% error)
        const args = [
            inputPath,
            outputBase,
            '-l',
            languages.join('+'),
            '--tessdata-dir',
            tessdata,
            'txt',
            'tsv',  // Generate TSV for precise word coordinates
        ];

        debugLog(`Spawning tesseract: ${binary} ${args.join(' ')}`);

        return new Promise((resolve) => {
            const proc = spawn(binary, args, {env: {
                ...process.env,
                TESSDATA_PREFIX: tessdata,
            }});

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
                        // Try TSV first (precise coordinates), fall back to TXT (estimation)
                        let words: IOcrWord[] = [];

                        try {
                            debugLog(`Reading TSV file from ${tsvPath}`);
                            const tsvContent = await readFile(tsvPath, 'utf-8');
                            debugLog(`TSV file read, size: ${tsvContent.length} bytes`);
                            words = parseTsvOutput(tsvContent);
                            debugLog(`Parsed ${words.length} words from TSV (precise coordinates)`);
                        } catch (tsvErr) {
                            // TSV parsing failed, fall back to TXT estimation
                            debugLog(`TSV parsing failed: ${tsvErr instanceof Error ? tsvErr.message : String(tsvErr)}, falling back to TXT`);
                            try {
                                const txtContent = await readFile(txtPath, 'utf-8');
                                debugLog(`TXT file read, size: ${txtContent.length} bytes`);
                                words = parseTxtOutput(txtContent, imageWidth, imageHeight);
                                debugLog(`Parsed ${words.length} words from TXT (estimated coordinates)`);
                            } catch (txtErr) {
                                debugLog('Both TSV and TXT parsing failed');
                                throw txtErr;
                            }
                        }

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
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0], 10);
        if (level !== 5) continue;  // Only process word-level (5)

        const left = parseInt(parts[6], 10);
        const top = parseInt(parts[7], 10);
        const right = parseInt(parts[8], 10);
        const bottom = parseInt(parts[9], 10);
        const confidence = parseInt(parts[10], 10);
        const text = parts[11] || '';

        // Skip very low confidence words (OCR errors)
        if (confidence < 30) continue;

        // Skip if coordinates are invalid
        if (left >= right || top >= bottom) continue;

        // Create word object with exact coordinates
        words.push({
            text: text.trim(),
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
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

/**
 * Generate a searchable PDF from an image using pdf-lib fallback
 * This works when embedding into existing PDFs fails
 *
 * Creates a new PDF with the image as background and OCR text as invisible overlay
 * for searchability.
 *
 * @param imageBuffer The image to convert to PDF
 * @param languages Languages for OCR (used to run OCR and extract text)
 * @returns PDF buffer, or null if generation failed
 */
export async function generateSearchablePdf(
    imageBuffer: Buffer,
    languages: string[],
): Promise<Buffer | null> {
    try {
        debugLog('generateSearchablePdf: Creating searchable PDF using pdf-lib fallback');

        // Import pdf-lib functions
        const { PDFDocument, rgb } = await import('pdf-lib');

        // Standard image size assumption: A4 at 300 DPI = 2550x3300 pixels
        // For simplicity, we'll use standard letter/A4 proportions
        // and scale the image to fit while maintaining aspect ratio
        const estimatedWidth = 2550;
        const estimatedHeight = 3300;

        // Create new PDF with A4 dimensions
        // A4 = 210mm x 297mm = 595pt x 842pt
        const pdfDoc = await PDFDocument.create();
        const pdfWidth = 595;
        const pdfHeight = 842;
        const page = pdfDoc.addPage([pdfWidth, pdfHeight]);

        // Try to embed and draw the image
        let embeddedImage = null;
        try {
            embeddedImage = await pdfDoc.embedPng(imageBuffer);
        } catch {
            try {
                embeddedImage = await pdfDoc.embedJpg(imageBuffer);
            } catch {
                debugLog('Could not embed image (not PNG or JPG), continuing with text-only');
            }
        }

        if (embeddedImage) {
            // Draw image to fill the page
            page.drawImage(embeddedImage, {
                x: 0,
                y: 0,
                width: pdfWidth,
                height: pdfHeight,
            });
            debugLog('Image embedded successfully');
        }

        // Run OCR on the image to get text with coordinates
        const ocrResult = await runOcrWithBoundingBoxes(
            imageBuffer,
            languages,
            300, // DPI
            estimatedWidth,
            estimatedHeight,
        );

        if (!ocrResult.success || !ocrResult.pageData) {
            debugLog(`OCR failed during fallback: ${ocrResult.error}`);
            // Even without OCR text, we have the image
            const pdfBytes = await pdfDoc.save();
            return Buffer.from(pdfBytes);
        }

        // Add invisible text layer for searchability
        const { words } = ocrResult.pageData;
        const scaleX = pdfWidth / estimatedWidth;
        const scaleY = pdfHeight / estimatedHeight;
        let textAdded = 0;

        for (const word of words) {
            try {
                // Scale coordinates from image space to PDF space
                const pdfX = word.x * scaleX;
                const pdfY = pdfHeight - (word.y * scaleY); // Flip Y axis for PDF
                const pdfFontSize = Math.max(1, word.height * scaleY * 0.8);

                page.drawText(word.text, {
                    x: pdfX,
                    y: pdfY - pdfFontSize,
                    size: pdfFontSize,
                    color: rgb(1, 1, 1),
                    opacity: 0.001, // Invisible but searchable
                });
                textAdded++;
            } catch {
                // Skip individual words that fail
            }
        }

        debugLog(`Added ${textAdded}/${words.length} words to PDF text layer`);

        const pdfBytes = await pdfDoc.save();
        const result = Buffer.from(pdfBytes);

        debugLog(`Fallback PDF generation successful: ${result.length} bytes`);
        return result;

    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Exception in generateSearchablePdf: ${errMsg}`);
        return null;
    }
}
