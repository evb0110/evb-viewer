import { app } from 'electron';
import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
    stat,
    unlink,
    open as openFileHandle,
} from 'fs/promises';
import {
    extname,
    basename,
    resolve,
    relative,
    sep,
    isAbsolute,
} from 'path';
import {
    isAllowedWritePath,
    isAllowedReadPath,
} from '@electron/utils/path-validator';
import { MAX_CHUNK } from '@electron/config/constants';

const ALLOWED_READ_EXTENSIONS = new Set([
    '.json',
    '.txt',
    '.tsv',
]);

const ALLOWED_BINARY_READ_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
]);

export async function handleFileRead(_event: Electron.IpcMainInvokeEvent, filePath: string): Promise<Uint8Array> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_BINARY_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    if (!isAllowedReadPath(normalizedPath)) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const buffer = await readFile(normalizedPath);
    return new Uint8Array(buffer);
}

export async function handleFileStat(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<{ size: number }> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    if (!isAllowedReadPath(normalizedPath)) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const s = await stat(normalizedPath);
    return { size: s.size };
}

export async function handleFileReadRange(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    offset: number,
    length: number,
): Promise<Uint8Array> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }
    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    if (!isAllowedReadPath(normalizedPath)) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const off = Number(offset);
    const len = Number(length);
    if (!Number.isFinite(off) || !Number.isFinite(len) || off < 0 || len <= 0) {
        throw new Error('Invalid range: offset must be >=0 and length must be >0');
    }

    const want = Math.min(len, MAX_CHUNK);

    const fh = await openFileHandle(normalizedPath, 'r');
    try {
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, off);
        return new Uint8Array(buf.subarray(0, bytesRead));
    } finally {
        await fh.close();
    }
}

export async function handleFileWrite(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: Uint8Array,
): Promise<boolean> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }

    const normalizedPath = filePath.trim();

    if (!isAllowedWritePath(normalizedPath)) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await writeFile(normalizedPath, data);
    return true;
}

export async function handleFileWriteDocx(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: Uint8Array,
): Promise<boolean> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }

    const normalizedPath = filePath.trim();
    if (extname(normalizedPath).toLowerCase() !== '.docx') {
        throw new Error('Invalid file type: only DOCX files are allowed');
    }

    if (!isAllowedWritePath(normalizedPath)) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await writeFile(normalizedPath, data);
    return true;
}

export async function handleFileReadText(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<string> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    if (!isAllowedReadPath(normalizedPath)) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const buffer = await readFile(normalizedPath, 'utf-8');
    return buffer;
}

export function handleFileExists(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): boolean {
    if (!filePath || filePath.trim() === '') {
        return false;
    }

    const normalizedPath = filePath.trim();

    if (!isAllowedReadPath(normalizedPath)) {
        return false;
    }

    return existsSync(normalizedPath);
}

export async function handleCleanupOcrTemp(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const tempDir = resolve(app.getPath('temp'));
        const absolutePath = resolve(normalizedPath);
        const relativePath = relative(tempDir, absolutePath);

        const isWithinTemp = (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );

        if (!isWithinTemp) {
            return;
        }

        const fileName = basename(absolutePath);
        const isOcrArtifact = fileName.startsWith('ocr-') || fileName.startsWith('searchable-');

        if (!isOcrArtifact) {
            return;
        }

        if (existsSync(absolutePath)) {
            await unlink(absolutePath);
        }
    } catch (err) {
        console.warn('[cleanup] Failed to delete OCR temp file:', err);
    }
}
