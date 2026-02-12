import { join } from 'path';
import {
    rename,
    unlink,
} from 'fs/promises';
import { existsSync } from 'fs';
import { runCommand } from '@electron/ocr/worker/run-command';
import { getOcrToolPaths } from '@electron/ocr/paths';

function getQpdfBinary() {
    return getOcrToolPaths().qpdf;
}

function makeTempPath(workingCopyPath: string) {
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return join(dir, `${id}.pdf`);
}

function buildComplementRanges(pagesToRemove: number[], totalPages: number) {
    const removeSet = new Set(pagesToRemove);
    const kept: number[] = [];
    for (let i = 1; i <= totalPages; i++) {
        if (!removeSet.has(i)) {
            kept.push(i);
        }
    }
    return kept;
}

function formatPageList(pages: number[]) {
    return pages.join(',');
}

async function atomicReplace(tempPath: string, targetPath: string) {
    await rename(tempPath, targetPath);
}

async function cleanupTemp(tempPath: string) {
    try {
        if (existsSync(tempPath)) {
            await unlink(tempPath);
        }
    } catch {
        // best-effort cleanup
    }
}

export async function extractPages(
    srcPath: string,
    destPath: string,
    pages: number[],
) {
    const qpdf = getQpdfBinary();
    const args = [
        srcPath,
        '--pages',
        srcPath,
        formatPageList(pages),
        '--',
        destPath,
    ];
    await runCommand(qpdf, args);
}

export async function deletePages(
    workingCopyPath: string,
    pagesToDelete: number[],
    totalPages: number,
) {
    const kept = buildComplementRanges(pagesToDelete, totalPages);
    if (kept.length === 0) {
        throw new Error('Cannot delete all pages from the document');
    }

    const qpdf = getQpdfBinary();
    const tempPath = makeTempPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            '--pages',
            workingCopyPath,
            formatPageList(kept),
            '--',
            tempPath,
        ];
        await runCommand(qpdf, args);
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }

    return { pageCount: kept.length };
}

export async function reorderPages(
    workingCopyPath: string,
    newOrder: number[],
) {
    const qpdf = getQpdfBinary();
    const tempPath = makeTempPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            '--pages',
            workingCopyPath,
            formatPageList(newOrder),
            '--',
            tempPath,
        ];
        await runCommand(qpdf, args);
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }

    return { pageCount: newOrder.length };
}

export type TRotationAngle = 90 | 180 | 270;

export async function rotatePages(
    workingCopyPath: string,
    pages: number[],
    angle: TRotationAngle,
) {
    const qpdf = getQpdfBinary();
    const tempPath = makeTempPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            `--rotate=+${angle}:${formatPageList(pages)}`,
            tempPath,
        ];
        await runCommand(qpdf, args);
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }
}
