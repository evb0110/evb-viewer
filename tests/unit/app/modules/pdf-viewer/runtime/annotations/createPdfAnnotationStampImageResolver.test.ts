import {
    computed,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IPlacedImageEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {createPdfAnnotationStampImageResolver} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationStampImageResolver';

const {mockResolveStampImageDataUrl} = vi.hoisted(() => ({mockResolveStampImageDataUrl: vi.fn(() => 'data:image/png;base64,stamp')}));
vi.mock('@app/modules/pdf-viewer/runtime/annotations/resolvePdfJsStampImageDataUrl', () => ({resolvePdfJsStampImageDataUrl: mockResolveStampImageDataUrl}));

const entity = {
    kind: 'placed-image',
    identity: {id: 'stamp-1'},
    pageIndex: 0,
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    rect: {
        left: 0,
        top: 0,
        width: 0.2,
        height: 0.2,
    },
    rotation: 0,
    image: {
        objectNumber: 11,
        generationNumber: 0,
        byteLength: 6,
        sha256: 'a'.repeat(64),
    },
} as IPlacedImageEntity;

describe('createPdfAnnotationStampImageResolver document ownership', () => {
    it('displays an unsaved raster from canonical bytes without reading the PDF', async () => {
        const leasePage = vi.fn();
        const resolveImage = createPdfAnnotationStampImageResolver({
            pdfDocument: computed(() => null),
            leasePage,
        });
        const raster: IPlacedImageEntity = {
            ...entity,
            image: {
                kind: 'raster',
                mimeType: 'image/png',
                dataBase64: 'AQID',
                byteLength: 3,
                sha256: 'a'.repeat(64),
                width: 2,
                height: 1,
            },
        };
        expect(await resolveImage(raster)).toBe('data:image/png;base64,AQID');
        expect(leasePage).not.toHaveBeenCalled();
    });

    it('does not resolve or cache a stamp after the document changes during page parsing', async () => {
        const firstDocument = {};
        const replacementDocument = {};
        const pdfDocument = ref<object | null>(firstDocument);
        const operatorList = Promise.withResolvers<undefined>();
        const page = {getOperatorList: vi.fn(() => operatorList.promise)};
        const release = vi.fn();
        const documentSession = {
            pdfDocument,
            leasePage: vi.fn(async () => ({
                page,
                release,
            })),
        };
        const resolveStampImage = createPdfAnnotationStampImageResolver(documentSession as never);

        const request = resolveStampImage(entity);
        await vi.waitFor(() => expect(page.getOperatorList).toHaveBeenCalledOnce());
        pdfDocument.value = replacementDocument;
        operatorList.resolve(undefined);

        await expect(request).resolves.toBeNull();
        expect(mockResolveStampImageDataUrl).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });
});
