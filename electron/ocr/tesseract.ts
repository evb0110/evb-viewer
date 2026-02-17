import { spawn } from 'child_process';
import { ensureTessdataLanguages } from '@electron/ocr/language-models';
import { getOcrPaths } from '@electron/ocr/paths';
import { resolveTesseractLanguageConfig } from '@electron/ocr/tesseract-language-config';

type TTesseractSpawnOptions = {threads?: number;};

interface IOcrResult {
    success: boolean;
    text: string;
    error?: string;
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
    const languageConfig = resolveTesseractLanguageConfig(languages);
    await ensureTessdataLanguages(languageConfig.orderedLanguages);

    const {
        binary,
        tessdata,
    } = getOcrPaths();

    const args = [
        'stdin',
        'stdout',
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        tessdata,
        ...languageConfig.extraConfigArgs,
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
