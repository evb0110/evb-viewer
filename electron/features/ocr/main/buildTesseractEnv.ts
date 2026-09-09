export function buildTesseractEnv(
    tessdataPath: string,
    threads?: number,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        TESSDATA_PREFIX: tessdataPath,
    };

    if (typeof threads === 'number' && Number.isFinite(threads) && threads > 0) {
        // If Tesseract is built with OpenMP, these variables control parallelism.
        // If not, they are ignored safely.
        const threadCount = String(Math.floor(threads));
        env.OMP_THREAD_LIMIT = threadCount;
        env.OMP_NUM_THREADS = threadCount;
    }

    return env;
}
