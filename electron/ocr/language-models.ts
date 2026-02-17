import { app } from 'electron';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
} from 'fs';
import {
    copyFile,
    mkdir,
    rename,
    rm,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('ocr-language-models');
const DOWNLOAD_BASE_URL = 'https://github.com/tesseract-ocr/tessdata_best/raw/main';
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;

const inFlightDownloads = new Map<string, Promise<void>>();
const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizeLanguageCodes(languageCodes: string[]): string[] {
    const deduped = new Set<string>();
    for (const languageCode of languageCodes) {
        const normalized = languageCode.trim().toLowerCase();
        if (normalized.length > 0) {
            deduped.add(normalized);
        }
    }
    return Array.from(deduped);
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function getBundledTessdataDir() {
    if (app.isPackaged) {
        return join(process.resourcesPath, 'tesseract', 'tessdata');
    }

    return join(__dirname, '..', 'resources', 'tesseract', 'tessdata');
}

export function getRuntimeTessdataDir() {
    if (app.isPackaged) {
        return join(app.getPath('userData'), 'tessdata');
    }

    return getBundledTessdataDir();
}

function getModelPath(baseDir: string, languageCode: string) {
    return join(baseDir, `${languageCode}.traineddata`);
}

function seedBundledModelsSync(runtimeDir: string) {
    if (!app.isPackaged) {
        return;
    }

    const bundledDir = getBundledTessdataDir();
    if (!existsSync(bundledDir)) {
        return;
    }

    mkdirSync(runtimeDir, { recursive: true });

    const bundledFiles = readdirSync(bundledDir)
        .filter(fileName => fileName.endsWith('.traineddata'));

    for (const fileName of bundledFiles) {
        const sourcePath = join(bundledDir, fileName);
        const destinationPath = join(runtimeDir, fileName);
        if (existsSync(destinationPath)) {
            continue;
        }
        copyFileSync(sourcePath, destinationPath);
    }
}

export function ensureRuntimeTessdataSeededSync() {
    const runtimeDir = getRuntimeTessdataDir();
    seedBundledModelsSync(runtimeDir);
}

async function seedBundledModels(runtimeDir: string) {
    if (!app.isPackaged) {
        return;
    }

    const bundledDir = getBundledTessdataDir();
    if (!existsSync(bundledDir)) {
        return;
    }

    await mkdir(runtimeDir, { recursive: true });

    const bundledFiles = readdirSync(bundledDir)
        .filter(fileName => fileName.endsWith('.traineddata'));

    for (const fileName of bundledFiles) {
        const sourcePath = join(bundledDir, fileName);
        const destinationPath = join(runtimeDir, fileName);
        if (existsSync(destinationPath)) {
            continue;
        }
        await copyFile(sourcePath, destinationPath);
    }
}

async function downloadLanguageModel(languageCode: string, runtimeDir: string) {
    const modelPath = getModelPath(runtimeDir, languageCode);
    if (existsSync(modelPath)) {
        return;
    }

    const languageUrl = `${DOWNLOAD_BASE_URL}/${encodeURIComponent(languageCode)}.traineddata`;
    const tempPath = `${modelPath}.download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

        try {
            log.info(`Downloading OCR model ${languageCode} (attempt ${attempt}/${DOWNLOAD_RETRIES})`);
            const response = await fetch(languageUrl, {
                method: 'GET',
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const modelBuffer = Buffer.from(arrayBuffer);
            if (modelBuffer.length < 1024) {
                throw new Error('Downloaded model is unexpectedly small');
            }

            await mkdir(runtimeDir, { recursive: true });
            await writeFile(tempPath, modelBuffer);
            await rename(tempPath, modelPath);
            log.info(`Downloaded OCR model ${languageCode} (${Math.round(modelBuffer.length / (1024 * 1024))}MB)`);
            return;
        } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            if (attempt >= DOWNLOAD_RETRIES) {
                throw new Error(`Failed to download OCR language model "${languageCode}": ${errMessage}`);
            }
            await delay(RETRY_DELAY_MS * attempt);
        } finally {
            clearTimeout(timeout);
            await rm(tempPath, { force: true }).catch(() => {});
        }
    }
}

async function ensureLanguageModel(languageCode: string, runtimeDir: string) {
    if (existsSync(getModelPath(runtimeDir, languageCode))) {
        return;
    }

    const pending = inFlightDownloads.get(languageCode);
    if (pending) {
        await pending;
        return;
    }

    const task = (async () => {
        await downloadLanguageModel(languageCode, runtimeDir);
    })();

    inFlightDownloads.set(languageCode, task);
    try {
        await task;
    } finally {
        inFlightDownloads.delete(languageCode);
    }
}

export async function ensureTessdataLanguages(languageCodes: string[]) {
    const requiredCodes = normalizeLanguageCodes(languageCodes);
    if (requiredCodes.length === 0) {
        return;
    }

    const runtimeDir = getRuntimeTessdataDir();
    await seedBundledModels(runtimeDir);
    await Promise.all(requiredCodes.map(languageCode => ensureLanguageModel(languageCode, runtimeDir)));
}
