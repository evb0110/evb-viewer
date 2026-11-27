import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getDocument,
    PDFDataRangeTransport,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

interface ISparseSegment {
    offset: number;
    bytes: Uint8Array;
}

const MAX_RANGE_REQUESTS = 32;
const MAX_REQUESTED_BYTES = 2 * 1024 * 1024;

class SparsePdfRangeTransport extends PDFDataRangeTransport {
    private readonly segments: readonly ISparseSegment[];
    private readonly onBudgetExceeded: (error: Error) => void;
    public requestCount = 0;
    public requestedBytes = 0;
    public budgetExceededError: Error | null = null;

    constructor(
        totalLength: number,
        segments: readonly ISparseSegment[],
        onBudgetExceeded: (error: Error) => void,
    ) {
        super(totalLength, null);
        this.segments = segments;
        this.onBudgetExceeded = onBudgetExceeded;
    }

    override requestDataRange(begin: number, end: number) {
        const clampedBegin = Math.max(0, begin);
        const clampedEnd = Math.min(this.length, end);
        const length = Math.max(0, clampedEnd - clampedBegin);
        this.requestCount += 1;
        this.requestedBytes += length;
        if (this.requestCount > MAX_RANGE_REQUESTS || this.requestedBytes > MAX_REQUESTED_BYTES) {
            if (!this.budgetExceededError) {
                this.budgetExceededError = new Error(
                    `Range read budget exceeded (${this.requestCount} requests, ${this.requestedBytes} bytes; last range [${clampedBegin}, ${clampedEnd}))`,
                );
                this.onBudgetExceeded(this.budgetExceededError);
            }
            return;
        }
        const chunk = new Uint8Array(length);
        for (const segment of this.segments) {
            const segEnd = segment.offset + segment.bytes.length;
            const overlapStart = Math.max(clampedBegin, segment.offset);
            const overlapEnd = Math.min(clampedEnd, segEnd);
            if (overlapStart < overlapEnd) {
                chunk.set(
                    segment.bytes.subarray(
                        overlapStart - segment.offset,
                        overlapEnd - segment.offset,
                    ),
                    overlapStart - clampedBegin,
                );
            }
        }
        queueMicrotask(() => {
            this.onDataRange(clampedBegin, chunk);
        });
    }
}

function encodeUnsignedBigEndian(value: number, byteWidth: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Expected a non-negative safe integer, got ${value}`);
    }
    const out = new Uint8Array(byteWidth);
    let remaining = BigInt(value);
    for (let index = byteWidth - 1; index >= 0; index -= 1) {
        out[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    if (remaining !== 0n) {
        throw new RangeError(`Value ${value} does not fit in ${byteWidth} bytes`);
    }
    return out;
}

function buildSparseWideXrefPdf({
    catalogOffset,
    offsetFieldWidth,
    pageWidth,
    pageHeight,
}: {
    catalogOffset: number;
    offsetFieldWidth: number;
    pageWidth: number;
    pageHeight: number;
}) {
    const encoder = new TextEncoder();
    const segments: ISparseSegment[] = [];

    const header = encoder.encode('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');
    segments.push({
        offset: 0,
        bytes: header,
    });

    // Place a valid zero-filled stream object (obj 5) spanning the gap from the
    // PDF header up to catalogOffset so every byte range in the sparse document
    // belongs to a well-formed PDF object.
    const fillerObjectOffset = header.length;
    const fillerFooter = encoder.encode('\nendstream\nendobj\n');
    let fillerLength = catalogOffset - fillerObjectOffset - fillerFooter.length - 64;
    let fillerHeader = new Uint8Array(0);
    for (let iteration = 0; iteration < 16; iteration += 1) {
        fillerHeader = encoder.encode(`5 0 obj\n<< /Length ${fillerLength} >>\nstream\n`);
        const nextLength = catalogOffset - fillerObjectOffset - fillerHeader.length - fillerFooter.length;
        if (nextLength === fillerLength) {
            break;
        }
        fillerLength = nextLength;
    }
    if (fillerLength < 0 || fillerObjectOffset + fillerHeader.length + fillerLength + fillerFooter.length !== catalogOffset) {
        throw new Error(`Could not align filler stream to catalogOffset=${catalogOffset}`);
    }
    segments.push({
        offset: fillerObjectOffset,
        bytes: fillerHeader,
    });
    segments.push({
        offset: catalogOffset - fillerFooter.length,
        bytes: fillerFooter,
    });

    let cursor = catalogOffset;
    const pushSegment = (text: string) => {
        const offset = cursor;
        const bytes = encoder.encode(text);
        segments.push({
            offset,
            bytes,
        });
        cursor += bytes.length;
        return offset;
    };

    const obj1Offset = pushSegment('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    const obj2Offset = pushSegment('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    const obj3Offset = pushSegment(
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 4 0 R >>\nendobj\n`,
    );
    const contentStream = 'q Q\n';
    const obj4Offset = pushSegment(
        `4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    );

    const xrefOffset = cursor;
    const entries: Array<[number, number, number]> = [
        [
            0,
            0,
            65535,
        ],
        [
            1,
            obj1Offset,
            0,
        ],
        [
            1,
            obj2Offset,
            0,
        ],
        [
            1,
            obj3Offset,
            0,
        ],
        [
            1,
            obj4Offset,
            0,
        ],
        [
            1,
            fillerObjectOffset,
            0,
        ],
        [
            1,
            xrefOffset,
            0,
        ],
    ];
    const rowWidth = 1 + offsetFieldWidth + 2;
    const xrefStreamData = new Uint8Array(entries.length * rowWidth);
    for (let index = 0; index < entries.length; index += 1) {
        const [
            type,
            offset,
            generation,
        ] = entries[index]!;
        const rowStart = index * rowWidth;
        xrefStreamData[rowStart] = type;
        xrefStreamData.set(encodeUnsignedBigEndian(offset, offsetFieldWidth), rowStart + 1);
        xrefStreamData.set(encodeUnsignedBigEndian(generation, 2), rowStart + 1 + offsetFieldWidth);
    }

    const xrefHeader = encoder.encode(
        `6 0 obj\n<< /Type /XRef /W [1 ${offsetFieldWidth} 2] /Size ${entries.length} /Root 1 0 R /Length ${xrefStreamData.length} >>\nstream\n`,
    );
    const xrefFooter = encoder.encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);

    segments.push({
        offset: cursor,
        bytes: xrefHeader,
    });
    cursor += xrefHeader.length;
    segments.push({
        offset: cursor,
        bytes: xrefStreamData,
    });
    cursor += xrefStreamData.length;
    segments.push({
        offset: cursor,
        bytes: xrefFooter,
    });
    cursor += xrefFooter.length;

    return {
        segments,
        totalLength: cursor,
    };
}

describe('vendored pdfjs-dist wide XRef stream offsets', () => {
    it.each([
        {
            label: '>2 GiB 4-byte unsigned offsets',
            catalogOffset: 0x8000_0100, // 2_147_483_904 (> 2 GiB, previously negative via << 8 |)
            offsetFieldWidth: 4,
            pageWidth: 210,
            pageHeight: 110,
        },
        {
            label: '>4 GiB 5-byte offsets',
            catalogOffset: 4_500_000_512,
            offsetFieldWidth: 5,
            pageWidth: 220,
            pageHeight: 120,
        },
        {
            label: '>10 GB decimal cutoff 8-byte offsets',
            catalogOffset: 10_000_000_586,
            offsetFieldWidth: 8,
            pageWidth: 240,
            pageHeight: 140,
        },
        {
            label: '>10 GiB binary 8-byte offsets',
            catalogOffset: (10 * 1024 * 1024 * 1024) + 586,
            offsetFieldWidth: 8,
            pageWidth: 260,
            pageHeight: 160,
        },
    ])('opens range-backed PDF 1.5 XRef stream with $label', async ({
        catalogOffset,
        offsetFieldWidth,
        pageWidth,
        pageHeight,
    }) => {
        const {
            segments,
            totalLength,
        } = buildSparseWideXrefPdf({
            catalogOffset,
            offsetFieldWidth,
            pageWidth,
            pageHeight,
        });
        let rejectBudget!: (error: Error) => void;
        const budgetFailure = new Promise<never>((_resolve, reject) => {
            rejectBudget = reject;
        });
        const range = new SparsePdfRangeTransport(totalLength, segments, rejectBudget);
        const loadingTask = getDocument({
            range,
            rangeChunkSize: 65_536,
            disableAutoFetch: true,
            disableStream: true,
            useWorkerFetch: false,
        });
        loadingTask.promise.catch(() => undefined);
        try {
            const pdfDocument = await Promise.race([
                loadingTask.promise,
                budgetFailure,
            ]);
            expect(range.budgetExceededError).toBeNull();
            expect(range.requestCount).toBeLessThanOrEqual(MAX_RANGE_REQUESTS);
            expect(range.requestedBytes).toBeLessThanOrEqual(MAX_REQUESTED_BYTES);
            expect(pdfDocument.numPages).toBe(1);
            const page = await pdfDocument.getPage(1);
            const viewport = page.getViewport({ scale: 1 });
            expect(viewport.width).toBe(pageWidth);
            expect(viewport.height).toBe(pageHeight);
        } finally {
            if (!range.budgetExceededError) {
                await loadingTask.destroy();
            }
        }
    });
});
