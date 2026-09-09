import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import { requireDocumentRef } from '@contracts/documentRef';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    createPdfRangeRequestBridge,
    type IPdfPreloadedRange,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/createPdfRangeRequestBridge';

const documentMocks = vi.hoisted(() => ({readFileRange: vi.fn()}));

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => documentMocks,
}));
vi.mock('@app/utils/pdfRenderTrace', () => ({logPdfRenderTrace: vi.fn()}));

const DELIVERY_BYTES = 1024 * 1024;
const SUBREAD_BYTES = 8 * DELIVERY_BYTES;

interface IRangeDelivery {
    begin: number;
    bytes: Uint8Array;
    isLast?: boolean;
}

class TestTransport extends PDFDataRangeTransport {
    constructor(private readonly deliveries: IRangeDelivery[]) {
        super(2 * 1024 * 1024 * 1024, null);
    }

    override onDataRange(begin: number, bytes: Uint8Array | null, isLast?: boolean) {
        if (!bytes) {
            throw new Error('Test transport received an empty range chunk');
        }
        const delivery: IRangeDelivery = {
            begin,
            bytes,
        };
        if (isLast !== undefined) {
            delivery.isLast = isLast;
        }
        this.deliveries.push(delivery);
    }
}

function createTransport(deliveries: IRangeDelivery[]) {
    return new TestTransport(deliveries);
}

function attachTransport(
    transport: TestTransport,
    getRenderVersion: () => number = () => 1,
    preloadedRanges: readonly IPdfPreloadedRange[] = [],
) {
    const bridge = createPdfRangeRequestBridge({
        getRenderVersion,
        onRangeReadFailure: vi.fn(),
    });
    const rangeFailure = bridge.createRangeReadFailureHandler();
    bridge.attachRangeRequestHandler(
        transport,
        {
            kind: 'path',
            path: requireDocumentRef('/tmp/sparse-2gib.pdf'),
            size: 2 * 1024 * 1024 * 1024,
        },
        1,
        rangeFailure,
        preloadedRanges,
    );
    return {
        bridge,
        rangeFailure,
    };
}

function createPatternChunk(offset: number, length: number, useArrayBuffer = false) {
    const bytes = useArrayBuffer
        ? new Uint8Array(new ArrayBuffer(length))
        : new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
        bytes[index] = (offset + index) % 251;
    }
    return bytes;
}

describe('createPdfRangeRequestBridge', () => {
    beforeEach(() => {
        documentMocks.readFileRange.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('streams a range larger than 64 MiB from a logical 2 GiB source in bounded chunks', async () => {
        const deliveries: IRangeDelivery[] = [];
        const transport = createTransport(deliveries);
        const {rangeFailure} = attachTransport(transport);
        const begin = 1_900_000_123;
        const length = (64 * DELIVERY_BYTES) + (3 * DELIVERY_BYTES) + 17;
        const end = begin + length;
        documentMocks.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            requestedLength: number,
        ) => createPatternChunk(offset, requestedLength));

        transport.requestDataRange!(begin, end);
        await vi.waitFor(() => expect(deliveries.length > 0 && deliveries.at(-1)?.isLast !== false).toBe(true));
        rangeFailure.complete();

        expect(documentMocks.readFileRange).toHaveBeenCalledTimes(Math.ceil(length / SUBREAD_BYTES));
        expect(deliveries.length).toBe(Math.ceil(length / DELIVERY_BYTES));
        let deliveredBytes = 0;
        for (const [
            index,
            delivery,
        ] of deliveries.entries()) {
            expect(delivery.begin).toBe(begin);
            expect(delivery.bytes.byteLength).toBe(
                Math.min(DELIVERY_BYTES, length - deliveredBytes),
            );
            expect(delivery.bytes.byteLength).toBeLessThanOrEqual(DELIVERY_BYTES);
            expect(delivery.bytes[0]).toBe((begin + deliveredBytes) % 251);
            expect(delivery.bytes.at(-1)).toBe((begin + deliveredBytes + delivery.bytes.byteLength - 1) % 251);
            expect(delivery.isLast).toBe(index === deliveries.length - 1 ? undefined : false);
            deliveredBytes += delivery.bytes.byteLength;
        }
        expect(deliveredBytes).toBe(length);
    });

    it('never allocates a buffer proportional to a large requested range', async () => {
        const allocations: number[] = [];
        const arrayBufferAllocations: number[] = [];
        const realUint8Array = Uint8Array;
        const realArrayBuffer = ArrayBuffer;
        const observedUint8Array = new Proxy(realUint8Array, {construct(target, args, newTarget) {
            const [firstArgument] = args;
            if (typeof firstArgument === 'number') {
                allocations.push(firstArgument);
            }
            return Reflect.construct(target, args, newTarget);
        }});
        const observedArrayBuffer = new Proxy(realArrayBuffer, {construct(target, args, newTarget) {
            const [firstArgument] = args;
            if (typeof firstArgument === 'number') {
                arrayBufferAllocations.push(firstArgument);
            }
            return Reflect.construct(target, args, newTarget);
        }});
        vi.stubGlobal('Uint8Array', observedUint8Array);
        vi.stubGlobal('ArrayBuffer', observedArrayBuffer);

        const deliveries: IRangeDelivery[] = [];
        const transport = createTransport(deliveries);
        const {rangeFailure} = attachTransport(transport);
        const begin = 1_000_000_000;
        const length = (65 * DELIVERY_BYTES) + 1;
        documentMocks.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            requestedLength: number,
        ) => createPatternChunk(offset, requestedLength, true));

        transport.requestDataRange!(begin, begin + length);
        await vi.waitFor(() => expect(deliveries.length > 0 && deliveries.at(-1)?.isLast !== false).toBe(true));
        rangeFailure.complete();

        expect(Math.max(...allocations)).toBeLessThanOrEqual(SUBREAD_BYTES);
        expect(Math.max(...arrayBufferAllocations)).toBeLessThanOrEqual(SUBREAD_BYTES);
        expect(allocations).not.toContain(length);
        expect(allocations).not.toContain(65 * DELIVERY_BYTES);
        expect(arrayBufferAllocations).not.toContain(length);
        expect(arrayBufferAllocations).not.toContain(65 * DELIVERY_BYTES);
    });

    it('drops a read that becomes stale without delivering bytes to the retired transport', async () => {
        const deliveries: IRangeDelivery[] = [];
        const transport = createTransport(deliveries);
        let renderVersion = 1;
        const pendingRead = Promise.withResolvers<Uint8Array>();
        documentMocks.readFileRange.mockReturnValueOnce(pendingRead.promise);
        const {rangeFailure} = attachTransport(transport, () => renderVersion);

        transport.requestDataRange!(512, 1024 * 1024 + 512);
        await vi.waitFor(() => expect(documentMocks.readFileRange).toHaveBeenCalledOnce());
        renderVersion = 2;
        pendingRead.resolve(createPatternChunk(512, DELIVERY_BYTES));
        await vi.waitFor(() => expect(documentMocks.readFileRange).toHaveBeenCalledOnce());
        rangeFailure.complete();

        expect(deliveries).toHaveLength(0);
    });

    it('serializes overlapping requests and preserves each request output order', async () => {
        const deliveries: IRangeDelivery[] = [];
        const transport = createTransport(deliveries);
        const reads: Array<PromiseWithResolvers<Uint8Array>> = [];
        documentMocks.readFileRange.mockImplementation(() => {
            const pendingRead = Promise.withResolvers<Uint8Array>();
            reads.push(pendingRead);
            return pendingRead.promise;
        });
        const {rangeFailure} = attachTransport(transport);

        transport.requestDataRange!(0, DELIVERY_BYTES);
        transport.requestDataRange!(DELIVERY_BYTES, 2 * DELIVERY_BYTES);
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        reads[0]!.resolve(createPatternChunk(0, DELIVERY_BYTES));
        await vi.waitFor(() => expect(reads).toHaveLength(2));
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.bytes[0]).toBe(0);
        reads[1]!.resolve(createPatternChunk(DELIVERY_BYTES, DELIVERY_BYTES));
        await vi.waitFor(() => expect(deliveries).toHaveLength(2));
        rangeFailure.complete();

        expect(deliveries.map(delivery => delivery.bytes[0])).toEqual([
            0,
            DELIVERY_BYTES % 251,
        ]);
        expect(deliveries.every(delivery => delivery.bytes.byteLength === DELIVERY_BYTES)).toBe(true);
    });
});
