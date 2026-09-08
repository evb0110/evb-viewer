import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IPlacedImageEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {createPdfAnnotationStampImageResolver} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationStampImageResolver';
import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import pdfjsRuntime from '@app/services/pdfjs/runtimeLib';

const {mockResolveStampImageDataUrl} = vi.hoisted(() => ({mockResolveStampImageDataUrl: vi.fn<() => string | null>(() => 'data:image/png;base64,stamp')}));
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
    beforeEach(() => mockResolveStampImageDataUrl.mockReset().mockReturnValue('data:image/png;base64,stamp'));

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

    function createDeferredImagePage(objectId = 'img_1') {
        const decoded = Promise.withResolvers<unknown>();
        const resolved = new Map<string, unknown>();
        const get = vi.fn((_id: string, callback: (value: unknown) => void) => {
            void decoded.promise.then(value => {
                resolved.set(objectId, value);
                callback(value);
            });
        });
        const objs = {
            get,
            [Symbol.iterator]: () => resolved[Symbol.iterator](),
        };
        const page: IPdfPage & {commonObjs: typeof objs} = {
            pageNumber: 1,
            rotate: 0,
            view: [
                0,
                0,
                100,
                100,
            ],
            objs: objectId.startsWith('g_') ? new Map() : objs,
            commonObjs: objs,
            getOperatorList: vi.fn(async () => ({
                fnArray: [pdfjsRuntime.OPS.dependency],
                argsArray: [[
                    objectId,
                    objectId,
                ]],
            })),
            getViewport: vi.fn(),
            getTextContent: vi.fn(),
            streamTextContent: vi.fn(),
            getAnnotations: vi.fn(),
            render: vi.fn(),
            cleanup: vi.fn(),
        };
        const document: IPdfDocument = {
            numPages: 1,
            annotationStorage: null,
            getPage: vi.fn(async () => page),
            getPageLabels: vi.fn(),
            getOutline: vi.fn(),
            getDestination: vi.fn(),
            getPageIndex: vi.fn(),
            saveDocument: vi.fn(),
            cleanup: vi.fn(),
            destroy: vi.fn(),
        };
        const activeDocument = shallowRef<IPdfDocument | null>(document);
        const pdfDocument = computed(() => activeDocument.value);
        const release = vi.fn();
        const leasePage = vi.fn(async () => ({
            page,
            release,
        }));
        return {
            decoded,
            resolved,
            get,
            pdfDocument,
            activeDocument,
            release,
            leasePage,
        };
    }

    it.each([
        {
            objectId: 'img_1',
            decodeFails: false,
        },
        {
            objectId: 'img_1',
            decodeFails: true,
        },
        {
            objectId: 'g_img_1',
            decodeFails: false,
        },
    ])('waits for $objectId after the operator list with decoded-null $decodeFails', async ({
        objectId,
        decodeFails,
    }) => {
        const fixture = createDeferredImagePage(objectId);
        const resolveImage = createPdfAnnotationStampImageResolver(fixture);
        mockResolveStampImageDataUrl.mockImplementation(() => fixture.resolved.get(objectId)
            ? 'data:image/png;base64,stamp'
            : null);
        const first = resolveImage(entity);
        const duplicate = resolveImage(entity);
        await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledOnce());
        expect(mockResolveStampImageDataUrl).not.toHaveBeenCalled();
        expect(fixture.release).not.toHaveBeenCalled();
        fixture.decoded.resolve(decodeFails ? null : {ref: '11R'});
        const expected = decodeFails ? null : 'data:image/png;base64,stamp';
        await expect(first).resolves.toBe(expected);
        await expect(duplicate).resolves.toBe(expected);
        expect(fixture.leasePage).toHaveBeenCalledOnce();
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(mockResolveStampImageDataUrl).toHaveBeenCalledWith({objs: fixture.resolved}, entity.image);
    });

    it('releases the page when the document closes before its image object arrives', async () => {
        const fixture = createDeferredImagePage();
        const resolveImage = createPdfAnnotationStampImageResolver(fixture);
        const request = resolveImage(entity);
        await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledOnce());
        fixture.activeDocument.value = null;
        await expect(request).resolves.toBeNull();
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(mockResolveStampImageDataUrl).not.toHaveBeenCalled();
        fixture.decoded.resolve({ref: '11R'});
        await fixture.decoded.promise;
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(mockResolveStampImageDataUrl).not.toHaveBeenCalled();
    });
});
