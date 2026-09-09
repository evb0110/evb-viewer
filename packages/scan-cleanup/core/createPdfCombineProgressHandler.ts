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
            try {
                const payload = JSON.parse(line) as {
                    processed?: unknown;
                    total?: unknown
                };
                const processed = typeof payload.processed === 'number' ? payload.processed : 0;
                const total = typeof payload.total === 'number' && payload.total > 0
                    ? payload.total
                    : Math.max(1, totalPages);
                onProcessed(Math.min(processed, total), total);
            } catch {
                onMalformedLine?.(line);
            }
        }
    };
}
