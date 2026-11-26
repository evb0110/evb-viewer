import {
    mkdtempSync, readFileSync, rmSync, 
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

interface IPdfAnnotationObjectRef {
    objectNumber: number;
    generationNumber: number;
}

export interface IPdfAnnotationIndexEntry {
    pageIndex: number;
    /** Zero marks an annotation stored as a direct dictionary. */
    objectNumber: number;
    generationNumber: number;
    subtype: string;
    name: string | null;
    popupRef: IPdfAnnotationObjectRef | null;
    parentRef: IPdfAnnotationObjectRef | null;
}

export interface IPdfAnnotationIndex {
    pageCount: number;
    entries: IPdfAnnotationIndexEntry[];
}

function parseObjectRef(value: unknown): IPdfAnnotationObjectRef | null {
    if (typeof value === 'string') {
        const match = /^(\d+)\s+(\d+)\s+R$/u.exec(value.trim());
        return match
            ? {
                objectNumber: Number(match[1]),
                generationNumber: Number(match[2]),
            }
            : null;
    }
    if (value && typeof value === 'object') {
        const ref = value as Partial<IPdfAnnotationObjectRef>;
        if (typeof ref.objectNumber === 'number' && typeof ref.generationNumber === 'number') {
            return {
                objectNumber: ref.objectNumber,
                generationNumber: ref.generationNumber,
            };
        }
    }
    return null;
}

/**
 * Reads every annotation of a saved PDF with the native page tool's
 * `annotation-index` verb, the same scanner the app's annotation saves use.
 */
export async function readPdfAnnotationIndex(filePath: string): Promise<IPdfAnnotationIndex> {
    const {resolveNativePageOpsPath} = await import('@electron/features/page-ops/public/nativePageOpsPath');
    const {runNativeToolCommand} = await import('@electron/native-tools/runNativeToolCommand');
    const pageOps = resolveNativePageOpsPath();
    const qpdf = getPdfNativeToolPaths().qpdf;
    if (!pageOps) {
        throw new Error('pdf-page-ops is required to read a PDF annotation index');
    }
    const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'evb-annotation-index-'));
    const outputPath = join(directory, 'index.jsonl');
    try {
        await runNativeToolCommand(pageOps, [
            'annotation-index',
            '--input',
            filePath,
            '--output',
            outputPath,
            '--qpdf',
            qpdf,
        ], {commandLabel: 'pdf-page-ops E2E annotation index'});
        const [
            header,
            ...lines
        ] = readFileSync(outputPath, 'utf8')
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => JSON.parse(line) as Record<string, unknown>);
        const entries = lines.flatMap((line) => {
            const pageIndex = line.pageIndex;
            const rawEntries = Array.isArray(line.entries)
                ? line.entries
                : Array.isArray(line.annotations) ? line.annotations : [line];
            return (rawEntries as Array<Record<string, unknown>>).map(entry => ({
                pageIndex: Number(entry.pageIndex ?? pageIndex),
                objectNumber: Number(entry.objectNumber),
                generationNumber: Number(entry.generationNumber),
                subtype: String(entry.subtype),
                name: typeof entry.name === 'string' ? entry.name : null,
                popupRef: parseObjectRef(entry.popupRef ?? entry.popup),
                parentRef: parseObjectRef(entry.parentRef ?? entry.parent),
            }));
        });
        return {
            pageCount: Number(header?.pageCount ?? 0),
            entries,
        };
    } finally {
        rmSync(directory, {
            recursive: true,
            force: true,
        });
    }
}
