import {
    existsSync,
    readdirSync,
} from 'fs';
import type { App } from 'electron';
import * as electron from 'electron';
import {
    ensureRuntimeTessdataSeeded,
    TESSDATA_BEST_REF,
} from '@electron/features/ocr/languageModels';
import { AVAILABLE_OCR_LANGUAGE_CODES } from '@electron/features/ocr/availableLanguages';
import { BUNDLED_OCR_LANGUAGE_CODES } from '@contracts/ocrLanguages';
import type { IOcrToolValidationResult } from '@contracts/electronApiOcr';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getErrorMessage } from '@electron/utils/error';
import {
    getOcrNativeToolPaths,
    type IOcrNativeToolPaths,
} from '@electron/features/ocr/main/nativeToolPaths';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

interface IOcrPaths {
    binary: string;
    tessdata: string;
}

export interface IOcrToolPaths extends IOcrNativeToolPaths {
    pdftoppm: string;
    pdftotext: string;
    pdfimages?: string;
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
    qpdf: string;
}

const toolValidationByResourceVersion = new Map<string, Promise<IOcrToolValidationResult>>();

function isElectronAppPackaged() {
    return (electron as {app?: Pick<App, 'isPackaged'>}).app?.isPackaged === true;
}

function createAwaitablePaths<T extends object>(paths: T): T & PromiseLike<T> {
    const seedPromise = ensureRuntimeTessdataSeeded();
    void seedPromise.catch(() => undefined);
    const awaitedPaths = {...paths};

    return Object.defineProperty(paths, 'then', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (
            onfulfilled?: (value: T) => unknown,
            onrejected?: (reason: unknown) => unknown,
        ) => seedPromise.then(() => onfulfilled?.(awaitedPaths) ?? awaitedPaths, onrejected),
    }) as T & PromiseLike<T>;
}

async function runProcess(
    command: string,
    args: string[],
    timeoutMs = 5_000,
) {
    try {
        return await runNativeToolCommand(command, args, {
            timeoutMs,
            commandLabel: `ocr-tool-probe(${command})`,
        });
    } catch (error) {
        return {
            exitCode: -1,
            stdout: '',
            stderr: getErrorMessage(error),
        };
    }
}

async function getToolVersion(path: string, versionFlag = '--version'): Promise<string | undefined> {
    if (!path || !existsSync(path)) {
        return undefined;
    }

    const result = await runProcess(path, [versionFlag], 5_000);
    if (result.exitCode !== 0) {
        return undefined;
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
    return match?.[1];
}

export function getOcrPaths(): IOcrPaths & PromiseLike<IOcrPaths> {
    const ocrPaths = getOcrNativeToolPaths();

    return createAwaitablePaths({
        binary: ocrPaths.tesseract,
        tessdata: ocrPaths.tessdata,
    });
}

export function getOcrToolPaths(): IOcrToolPaths & PromiseLike<IOcrToolPaths> {
    const ocrPaths = getOcrNativeToolPaths();
    const pdfPaths = getPdfNativeToolPaths();
    const paths: IOcrToolPaths = {
        tesseract: ocrPaths.tesseract,
        tessdata: ocrPaths.tessdata,
        pdftoppm: pdfPaths.pdftoppm,
        pdftotext: pdfPaths.pdftotext,
        qpdf: pdfPaths.qpdf,
    };
    if (pdfPaths.pdfimages !== undefined) {
        paths.pdfimages = pdfPaths.pdfimages;
    }
    if (pdfPaths.popplerDataDir !== undefined) {
        paths.popplerDataDir = pdfPaths.popplerDataDir;
    }
    if (pdfPaths.popplerFontConfigDir !== undefined) {
        paths.popplerFontConfigDir = pdfPaths.popplerFontConfigDir;
    }
    if (ocrPaths.unpaper !== undefined) {
        paths.unpaper = ocrPaths.unpaper;
    }

    return createAwaitablePaths(paths);
}

async function checkToolExists(path: string) {
    // If path contains a directory separator, check if file exists
    if (path.includes('/') || path.includes('\\')) {
        return existsSync(path);
    }

    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = await runProcess(cmd, [path], 5_000);
    return result.exitCode === 0;
}

function getAvailableLanguages(tessdataPath: string): string[] {
    if (!existsSync(tessdataPath)) {
        return [];
    }
    try {
        const files = readdirSync(tessdataPath);
        return files
            .filter((f) => f.endsWith('.traineddata'))
            .map((f) => f.replace('.traineddata', ''));
    } catch {
        return [];
    }
}

function getMissingSupportedLanguages(languages: string[] | undefined): string[] {
    const languageSet = new Set(languages ?? []);
    return Array.from(AVAILABLE_OCR_LANGUAGE_CODES)
        .filter(languageCode => !languageSet.has(languageCode))
        .sort();
}

async function validateRequiredTool(
    name: string,
    path: string,
    errors: string[],
    notFoundMessage: (path: string) => string,
) {
    const found = await checkToolExists(path);
    if (!found) {
        errors.push(notFoundMessage(path));
    }
    return found;
}

async function validateTesseractTool(path: string, errors: string[]) {
    const found = await validateRequiredTool(
        'Tesseract',
        path,
        errors,
        toolPath => `Tesseract binary not found: ${toolPath}`,
    );
    const version = found ? await getToolVersion(path) : undefined;
    const result: {
        found: boolean;
        version?: string;
    } = {found};
    if (version !== undefined) {
        result.version = version;
    }
    return result;
}

function validateTessdata(path: string, errors: string[]) {
    const found = existsSync(path);
    const languages = found ? getAvailableLanguages(path) : undefined;
    const languageSet = new Set(languages ?? []);
    const missingBundledLanguages = found
        ? BUNDLED_OCR_LANGUAGE_CODES.filter(languageCode => !languageSet.has(languageCode))
        : [];
    const onDemandLanguages = found ? getMissingSupportedLanguages(languages) : [];
    if (!found) {
        errors.push(`Tessdata directory not found: ${path}`);
    } else if (languages && languages.length === 0) {
        errors.push(`No language models found in tessdata: ${path}`);
    } else if (missingBundledLanguages.length > 0) {
        errors.push(`Missing bundled language models in tessdata: ${missingBundledLanguages.join(', ')}`);
    }
    const result: {
        found: boolean;
        languages?: string[];
        onDemandLanguages?: string[];
        complete: boolean;
    } = {
        found,
        complete: found && missingBundledLanguages.length === 0 && Boolean(languages?.length),
    };
    if (languages !== undefined) {
        result.languages = languages;
    }
    if (onDemandLanguages.length > 0) {
        result.onDemandLanguages = onDemandLanguages;
    }
    return result;
}

function validatePopplerRuntime(paths: IOcrToolPaths, errors: string[]) {
    const dataDirFound = !!paths.popplerDataDir && existsSync(paths.popplerDataDir);
    const fontConfigDirFound = !!paths.popplerFontConfigDir && existsSync(paths.popplerFontConfigDir);
    const isPackaged = isElectronAppPackaged();
    const requiresBundledDataDir = process.platform === 'win32' || (isPackaged && process.platform === 'linux');
    const requiresBundledFontConfig = isPackaged && process.platform === 'linux';
    if (requiresBundledDataDir && !dataDirFound) {
        errors.push(`Poppler data directory not found: ${paths.popplerDataDir?.length ? paths.popplerDataDir : '(unset)'} (expected <resources>/poppler/<platform>/share/poppler)`);
    }
    if (requiresBundledFontConfig && !fontConfigDirFound) {
        errors.push(`Poppler fontconfig directory not found: ${paths.popplerFontConfigDir?.length ? paths.popplerFontConfigDir : '(unset)'} (expected <resources>/poppler/<platform>/etc/fonts)`);
    }
    const result: {
        dataDirFound: boolean;
        dataDir?: string;
        fontConfigDirFound: boolean;
        fontConfigDir?: string;
        valid: boolean;
    } = {
        dataDirFound,
        fontConfigDirFound,
        valid: (!requiresBundledDataDir || dataDirFound) && (!requiresBundledFontConfig || fontConfigDirFound),
    };
    if (paths.popplerDataDir !== undefined) {
        result.dataDir = paths.popplerDataDir;
    }
    if (paths.popplerFontConfigDir !== undefined) {
        result.fontConfigDir = paths.popplerFontConfigDir;
    }
    return result;
}

async function validateOcrToolsUncached(paths: IOcrToolPaths): Promise<IOcrToolValidationResult> {
    const errors: string[] = [];

    const tesseract = await validateTesseractTool(paths.tesseract, errors);
    const tessdata = validateTessdata(paths.tessdata, errors);
    const pdftoppmFound = await validateRequiredTool(
        'pdftoppm',
        paths.pdftoppm,
        errors,
        path => `pdftoppm not found: ${path} (install Poppler or bundle it)`,
    );
    const pdftotextFound = await validateRequiredTool(
        'pdftotext',
        paths.pdftotext,
        errors,
        path => `pdftotext not found: ${path} (install Poppler or bundle it)`,
    );
    const popplerRuntime = validatePopplerRuntime(paths, errors);
    const qpdfFound = await validateRequiredTool(
        'qpdf',
        paths.qpdf,
        errors,
        path => `qpdf not found: ${path} (install qpdf or bundle it)`,
    );
    const valid = tesseract.found
        && tessdata.found
        && tessdata.complete
        && pdftoppmFound
        && pdftotextFound
        && qpdfFound
        && popplerRuntime.valid;
    const tools: IOcrToolValidationResult['tools'] = {
        tesseract: {
            found: tesseract.found,
            path: paths.tesseract,
            ...(tesseract.version === undefined ? {} : {version: tesseract.version}),
        },
        tessdata: {
            found: tessdata.found,
            path: paths.tessdata,
            ...(tessdata.languages === undefined ? {} : {languages: [...tessdata.languages]}),
            ...(tessdata.onDemandLanguages === undefined
                ? {}
                : {onDemandLanguages: [...tessdata.onDemandLanguages]}),
        },
        pdftoppm: {
            found: pdftoppmFound,
            path: paths.pdftoppm,
        },
        pdftotext: {
            found: pdftotextFound,
            path: paths.pdftotext,
        },
        popplerRuntime: {
            dataDirFound: popplerRuntime.dataDirFound,
            ...(popplerRuntime.dataDir === undefined ? {} : {dataDir: popplerRuntime.dataDir}),
            fontConfigDirFound: popplerRuntime.fontConfigDirFound,
            ...(popplerRuntime.fontConfigDir === undefined
                ? {}
                : {fontConfigDir: popplerRuntime.fontConfigDir}),
        },
        qpdf: {
            found: qpdfFound,
            path: paths.qpdf,
        },
    };
    return {
        valid,
        tools,
        errors,
    };
}

export async function validateOcrTools(): Promise<IOcrToolValidationResult> {
    const paths = await getOcrToolPaths();
    const installedLanguages = getAvailableLanguages(paths.tessdata).sort().join(',');
    const resourceVersion = [
        TESSDATA_BEST_REF,
        process.platform,
        process.arch,
        paths.tesseract,
        paths.pdftoppm,
        paths.pdftotext,
        paths.qpdf,
        installedLanguages,
    ].join('|');
    let validation = toolValidationByResourceVersion.get(resourceVersion);
    if (!validation) {
        validation = validateOcrToolsUncached(paths);
        toolValidationByResourceVersion.set(resourceVersion, validation);
        void validation.catch(() => toolValidationByResourceVersion.delete(resourceVersion));
    }
    return validation;
}
