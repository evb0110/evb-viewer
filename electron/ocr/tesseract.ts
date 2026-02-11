import { spawn } from 'child_process';
import { getOcrPaths } from '@electron/ocr/paths';

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

