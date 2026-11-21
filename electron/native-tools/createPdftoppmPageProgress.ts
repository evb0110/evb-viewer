/**
 * Turns `pdftoppm -progress` stderr into finished pages. Poppler writes
 * `<page> <last selected page> <output path>` after each page's image, LF or
 * CRLF ended. The path fills the rest of the line and may hold spaces, so only
 * the two leading integers are read. Chunks may split or join lines, and
 * Poppler's diagnostics share the stream; every other line is ignored.
 */
export function createPdftoppmPageProgress(onPage: (pageNumber: number) => void) {
    let partialLine = '';
    return (chunk: string) => {
        const lines = (partialLine + chunk).split(/\r?\n/u);
        partialLine = lines.pop() ?? '';
        for (const line of lines) {
            const match = /^(\d+) \d+ /u.exec(line);
            if (match !== null) {
                onPage(Number(match[1]));
            }
        }
    };
}
