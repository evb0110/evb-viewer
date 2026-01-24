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
import type { IOcrWord } from '@app/types/shared';

const log = createLogger('tesseract');

type TTesseractSpawnOptions = {threads?: number;};

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

interface IOcrPageData {
    words: IOcrWord[];
    text: string;
    pageWidth: number;
    pageHeight: number;
}

function buildTesseractEnv(
    tessdata: string,
    options?: TTesseractSpawnOptions,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        TESSDATA_PREFIX: tessdata,
    };

    const threads = options?.threads;
    if (typeof threads === 'number' && Number.isFinite(threads) && threads > 0) {
        // If Tesseract is built with OpenMP, these variables control parallelism.
        // If not, they are ignored safely.
        env.OMP_THREAD_LIMIT = String(Math.floor(threads));
        env.OMP_NUM_THREADS = String(Math.floor(threads));
    }

    return env;
}

export async function runOcr(
    imageBuffer: Buffer,
    languages: string[],
    options?: TTesseractSpawnOptions,
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
        // PSM 3 (default/auto) detects multi-column layouts and two-page spreads
        '-c',
        'preserve_interword_spaces=1',  // Maintain word boundaries
        // Lower minimum space thresholds (more aggressive space detection)
        '-c',
        'textord_words_default_minspace=0.3',  // Default 0.6
        '-c',
        'textord_words_min_minspace=0.2',  // Default 0.3
        // Fuzzy space parameters - more sensitive detection
        '-c',
        'tosp_fuzzy_space_factor=0.5',  // Default 0.6
        '-c',
        'tosp_min_sane_kn_sp=1.2',  // Default 1.5
        // Kern gap factors - more likely to insert spaces
        '-c',
        'tosp_kern_gap_factor1=1.5',  // Default 2
        '-c',
        'tosp_kern_gap_factor2=1.0',  // Default 1.3
        // Disable dictionary influence (prevents word merging)
        '-c',
        'load_system_dawg=0',
        '-c',
        'load_freq_dawg=0',
    ];

    return new Promise((resolve) => {
        const proc = spawn(binary, args, {env: buildTesseractEnv(tessdata, options)});

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
    options?: TTesseractSpawnOptions,
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
            // PSM 3 (default/auto) detects multi-column layouts and two-page spreads
            '-c',
            'preserve_interword_spaces=1',  // Maintain word boundaries
            // Lower minimum space thresholds (more aggressive space detection)
            '-c',
            'textord_words_default_minspace=0.3',  // Default 0.6
            '-c',
            'textord_words_min_minspace=0.2',  // Default 0.3
            // Fuzzy space parameters - more sensitive detection
            '-c',
            'tosp_fuzzy_space_factor=0.5',  // Default 0.6
            '-c',
            'tosp_min_sane_kn_sp=1.2',  // Default 1.5
            // Kern gap factors - more likely to insert spaces
            '-c',
            'tosp_kern_gap_factor1=1.5',  // Default 2
            '-c',
            'tosp_kern_gap_factor2=1.0',  // Default 1.3
            // Disable dictionary influence (prevents word merging)
            '-c',
            'load_system_dawg=0',
            '-c',
            'load_freq_dawg=0',
            '-c',
            'tessedit_create_pdf=1',  // Generate PDF with text layer
        ];

        log.debug(`Spawning tesseract for PDF generation: ${binary} ${args.join(' ')}`);

        return new Promise((resolve) => {
            const proc = spawn(binary, args, {env: buildTesseractEnv(tessdata, options)});

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
    options?: TTesseractSpawnOptions,
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

    try {
        const args = [
            'stdin',
            'stdout',
            '-l',
            languages.join('+'),
            '--tessdata-dir',
            tessdata,
            // PSM 3 (default/auto) detects multi-column layouts and two-page spreads
            '-c',
            'preserve_interword_spaces=1',  // Maintain word boundaries
            // Lower minimum space thresholds (more aggressive space detection)
            '-c',
            'textord_words_default_minspace=0.3',  // Default 0.6
            '-c',
            'textord_words_min_minspace=0.2',  // Default 0.3
            // Fuzzy space parameters - more sensitive detection
            '-c',
            'tosp_fuzzy_space_factor=0.5',  // Default 0.6
            '-c',
            'tosp_min_sane_kn_sp=1.2',  // Default 1.5
            // Kern gap factors - more likely to insert spaces
            '-c',
            'tosp_kern_gap_factor1=1.5',  // Default 2
            '-c',
            'tosp_kern_gap_factor2=1.0',  // Default 1.3
            // Disable dictionary influence (prevents word merging)
            '-c',
            'load_system_dawg=0',
            '-c',
            'load_freq_dawg=0',
            '-c',
            'tessedit_create_tsv=1',  // Generate TSV for precise word coordinates
        ];

        log.debug(`Spawning tesseract: ${binary} ${args.join(' ')}`);

        return new Promise((resolve) => {
            const proc = spawn(binary, args, {env: buildTesseractEnv(tessdata, options)});

            log.debug('Process spawned, setting up listeners');

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data: Buffer) => {
                const msg = data.toString();
                stderr += msg;
                log.debug(`stderr: ${msg.trim()}`);
            });

            proc.on('close', (code) => {
                log.debug(`Process closed with code ${code}`);
                if (code === 0) {
                    try {
                        const tsvContent = stdout.trim();
                        const words = parseTsvOutput(tsvContent);
                        const pageText = parseTsvText(tsvContent);
                        log.debug(`Parsed ${words.length} words from TSV output`);

                        resolve({
                            success: true,
                            pageData: {
                                words,
                                text: pageText,
                                pageWidth: imageWidth,
                                pageHeight: imageHeight,
                            },
                        });
                    } catch (parseErr) {
                        const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                        log.debug(`Failed to parse TSV output: ${parseMsg}`);
                        resolve({
                            success: false,
                            pageData: null,
                            error: parseMsg,
                        });
                    }
                    return;
                }

                log.debug(`Tesseract failed with code ${code}, stderr: ${stderr}`);
                resolve({
                    success: false,
                    pageData: null,
                    error: stderr || `Tesseract exited with code ${code}`,
                });
            });

            proc.on('error', (err) => {
                log.debug(`Process error: ${err.message}`);
                resolve({
                    success: false,
                    pageData: null,
                    error: err.message,
                });
            });

            // Write image data to stdin and close
            proc.stdin.write(imageBuffer);
            proc.stdin.end();
        });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Exception: ${errMsg}`);
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
 * Reconstruct plain text from Tesseract TSV output.
 * Uses Tesseract's reading order (TSV line order) and inserts line breaks when
 * the detected line changes.
 */
function parseTsvText(tsvContent: string): string {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return '';
    }

    const outputLines: string[] = [];
    let currentLineKey: string | null = null;
    let currentWords: string[] = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;  // Word-level only

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
