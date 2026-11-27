import * as v from 'valibot';
import {PDF_IMAGE_COMBINE_PROGRESS_SCHEMA} from '@contracts/pdfImageCombineProgress';

export function createPdfCombineProgressHandler(
    totalPages: number,
    onProcessed: (processed: number, total: number) => void,
    onMalformedLine?: (line: string) => void,
) {
    let buffer = '';
    return (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(line);
            } catch {
                onMalformedLine?.(line);
                continue;
            }
            const parsed = v.safeParse(PDF_IMAGE_COMBINE_PROGRESS_SCHEMA, raw, {abortEarly: true});
            if (!parsed.success) {
                onMalformedLine?.(line);
                continue;
            }
            const total = parsed.output.total > 0
                ? parsed.output.total
                : Math.max(1, totalPages);
            onProcessed(Math.min(parsed.output.processed, total), total);
        }
    };
}
