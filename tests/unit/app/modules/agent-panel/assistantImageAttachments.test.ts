import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
    ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
    buildComposerImageAttachments,
    buildExpandedImagePreview,
    getClipboardImageFiles,
    getAssistantImagePreviewUrl,
    navigateExpandedImagePreview,
    type TAssistantComposerImage,
} from '@app/modules/agent-panel/utils/assistantImageAttachments';

type TFileOverrides = Partial<Pick<File, 'name' | 'size' | 'type'>>;

interface IClipboardItemFixture {
    kind: DataTransferItem['kind'];
    type: string;
    getAsFile: () => File | null;
}

interface IDataTransferFixture {
    files: readonly File[];
    items: readonly IClipboardItemFixture[];
}

function createFileLike(patch: TFileOverrides = {}) {
    const name = patch.name ?? 'image.png';
    const size = patch.size ?? 100;
    const type = patch.type ?? 'image/png';
    return new File([new Uint8Array(size)], name, {type});
}

function createFileList(files: readonly File[]): FileList {
    const fileList = [...files];
    return Object.assign(fileList, {item: (index: number) => fileList[index] ?? null});
}

function createDataTransferItem(fixture: IClipboardItemFixture): DataTransferItem {
    return {
        kind: fixture.kind,
        type: fixture.type,
        getAsFile: fixture.getAsFile,
        getAsString: callback => callback?.(''),
        webkitGetAsEntry: () => null,
    };
}

function createDataTransferItemList(fixtures: readonly IClipboardItemFixture[]): DataTransferItemList {
    const items = fixtures.map(createDataTransferItem);
    return Object.assign(items, {
        add: (_data: string | File, _type?: string) => null,
        clear: () => { items.length = 0; },
        remove: (index: number) => { items.splice(index, 1); },
    });
}

function createDataTransfer(fixture: IDataTransferFixture): DataTransfer {
    const dataTransfer = {
        dropEffect: 'none',
        effectAllowed: 'none',
        files: createFileList(fixture.files),
        items: createDataTransferItemList(fixture.items),
        types: [],
        clearData: (_format?: string) => undefined,
        getData: (_format: string) => '',
        setData: (_format: string, _data: string) => undefined,
        setDragImage: (_image: Element, _x: number, _y: number) => undefined,
    } satisfies DataTransfer;
    return dataTransfer;
}

function createImageAttachment(patch: Partial<TAssistantComposerImage> = {}): TAssistantComposerImage {
    return {
        type: 'image',
        id: 'image-1',
        name: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
        ...patch,
    };
}

describe('assistantImageAttachments', () => {
    it('builds image attachments with injected ids and readers', async () => {
        const result = await buildComposerImageAttachments({
            files: [
                createFileLike({
                    name: ' First.PNG ',
                    type: 'IMAGE/PNG', 
                }),
                createFileLike({
                    name: '',
                    type: 'image/jpeg', 
                }),
            ],
            existingImages: [],
            fallbackName: index => `Image ${index + 1}`,
            createId: () => 'generated-id',
            readFile: async file => `data:${file.type.toLowerCase()};base64,abc`,
            probeFile: async file => ({
                bytes: new Uint8Array(file.size),
                width: 100,
                height: 50,
                frameCount: 1,
                mimeType: file.type.toLowerCase(),
            }),
            buildPreview: async () => 'data:image/png;base64,preview',
        });

        expect(result.error).toBeNull();
        expect(result.images).toEqual([
            {
                type: 'image',
                id: 'generated-id',
                name: 'First.PNG',
                mimeType: 'image/png',
                sizeBytes: 100,
                dataUrl: 'data:image/png;base64,abc',
                previewDataUrl: 'data:image/png;base64,preview',
            },
            {
                type: 'image',
                id: 'generated-id',
                name: 'Image 2',
                mimeType: 'image/jpeg',
                sizeBytes: 100,
                dataUrl: 'data:image/jpeg;base64,abc',
                previewDataUrl: 'data:image/png;base64,preview',
            },
        ]);
    });

    it('keeps valid images and reports the last recoverable validation error', async () => {
        const result = await buildComposerImageAttachments({
            files: [
                createFileLike({
                    name: 'text.txt',
                    type: 'text/plain', 
                }),
                createFileLike({
                    name: 'large.png',
                    size: ASSISTANT_MAX_IMAGE_BYTES + 1, 
                }),
                createFileLike({ name: 'ok.png' }),
            ],
            existingImages: [],
            fallbackName: index => `Image ${index + 1}`,
            createId: () => 'ok-id',
            readFile: async () => 'data:image/png;base64,abc',
            probeFile: async file => ({
                bytes: new Uint8Array(file.size),
                width: 100,
                height: 50,
                frameCount: 1,
                mimeType: file.type.toLowerCase(),
            }),
            buildPreview: async () => 'data:image/png;base64,preview',
        });

        expect(result.images).toHaveLength(1);
        expect(result.images[0]?.name).toBe('ok.png');
        expect(result.error).toEqual({
            type: 'too-large',
            name: 'large.png',
            size: ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
        });
    });

    it('stops adding images once the attachment limit is reached', async () => {
        const existingImages = Array.from({ length: ASSISTANT_MAX_IMAGE_ATTACHMENTS }, (_, index) => (
            createImageAttachment({ id: `existing-${index}` })
        ));

        const result = await buildComposerImageAttachments({
            files: [createFileLike()],
            existingImages,
            fallbackName: index => `Image ${index + 1}`,
            readFile: async () => 'data:image/png;base64,abc',
            probeFile: async file => ({
                bytes: new Uint8Array(file.size),
                width: 100,
                height: 50,
                frameCount: 1,
                mimeType: file.type.toLowerCase(),
            }),
            buildPreview: async () => 'data:image/png;base64,preview',
        });

        expect(result.images).toHaveLength(ASSISTANT_MAX_IMAGE_ATTACHMENTS);
        expect(result.error).toEqual({
            type: 'limit',
            count: ASSISTANT_MAX_IMAGE_ATTACHMENTS,
        });
    });

    it('uses data transfer files before item fallbacks', () => {
        const directFile = createFileLike({ name: 'direct.png' });
        const itemFile = createFileLike({ name: 'item.png' });
        const transfer = createDataTransfer({
            files: [directFile],
            items: [{
                kind: 'file',
                type: 'image/png',
                getAsFile: () => itemFile,
            }],
        });

        expect(getClipboardImageFiles(transfer)).toEqual([directFile]);
    });

    it('filters item fallbacks to image files', () => {
        const itemFile = createFileLike({ name: 'item.png' });
        const transfer = createDataTransfer({
            files: [],
            items: [
                {
                    kind: 'string',
                    type: 'image/png',
                    getAsFile: () => itemFile,
                },
                {
                    kind: 'file',
                    type: 'text/plain',
                    getAsFile: () => createFileLike({ type: 'text/plain' }),
                },
                {
                    kind: 'file',
                    type: 'image/png',
                    getAsFile: () => itemFile,
                },
            ],
        });

        expect(getClipboardImageFiles(transfer)).toEqual([itemFile]);
    });

    it('builds preview data and wraps preview navigation', () => {
        const preview = buildExpandedImagePreview([
            createImageAttachment({
                id: 'first',
                name: 'First', 
            }),
            createImageAttachment({
                id: 'pdf',
                dataUrl: 'data:application/pdf;base64,abc', 
            }),
            createImageAttachment({
                id: 'second',
                name: 'Second', 
            }),
        ], 'second');

        expect(preview).toEqual({
            images: [
                {
                    src: 'data:image/png;base64,aW1hZ2U=',
                    name: 'First',
                },
                {
                    src: 'data:image/png;base64,aW1hZ2U=',
                    name: 'Second',
                },
            ],
            index: 1,
        });
        expect(navigateExpandedImagePreview(preview, 1)?.index).toBe(0);
        expect(navigateExpandedImagePreview(preview, -1)?.index).toBe(0);
        expect(buildExpandedImagePreview([], 'missing')).toBeNull();
    });

    it('uses a bounded static preview without changing the original payload', () => {
        const image = createImageAttachment({
            dataUrl: 'data:image/gif;base64,animated',
            previewDataUrl: 'data:image/png;base64,static',
        });

        expect(getAssistantImagePreviewUrl(image)).toBe('data:image/png;base64,static');
        expect(image.dataUrl).toBe('data:image/gif;base64,animated');
    });
});
