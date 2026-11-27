import type {IExportPageSize} from '@electron/features/image-export/main/imageExportResourceLimits';

const PDFINFO_PAGE_SIZE_LINE_RE = /^Page(?:\s+\d+)?\s+size:\s+([\d.]+)\s*x\s*([\d.]+)\s*pts/u;
const PDFINFO_PAGE_SIZE_STREAM_LINE_MAX_LENGTH = 1024 * 1024;

export function parsePdfInfoPageSizeLine(line: string): IExportPageSize | null {
    const match = PDFINFO_PAGE_SIZE_LINE_RE.exec(line);
    if (!match) {
        return null;
    }

    const widthPts = Number.parseFloat(match[1] ?? '');
    const heightPts = Number.parseFloat(match[2] ?? '');
    if (!Number.isFinite(widthPts) || !Number.isFinite(heightPts) || widthPts <= 0 || heightPts <= 0) {
        return null;
    }

    return {
        widthPts,
        heightPts,
    };
}

/**
 * Splits streamed pdfinfo stdout into lines and hands every parsed page-size
 * record to `onPageSize`. The full output is consumed this way, and only one
 * line is buffered.
 */
export function createPdfInfoPageSizeStreamScanner(onPageSize: (pageSize: IExportPageSize) => void) {
    let pendingLine = '';
    return (chunk: string) => {
        pendingLine += chunk;
        for (;;) {
            const newlineIndex = pendingLine.indexOf('\n');
            if (newlineIndex < 0) {
                break;
            }
            const line = pendingLine.slice(0, newlineIndex).replace(/\r$/u, '');
            pendingLine = pendingLine.slice(newlineIndex + 1);
            const pageSize = parsePdfInfoPageSizeLine(line);
            if (pageSize) {
                onPageSize(pageSize);
            }
        }
        if (pendingLine.length > PDFINFO_PAGE_SIZE_STREAM_LINE_MAX_LENGTH) {
            pendingLine = '';
        }
    };
}
