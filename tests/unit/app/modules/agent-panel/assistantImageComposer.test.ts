// @vitest-environment happy-dom

import {createApp, defineComponent, h, nextTick, ref} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Ref} from 'vue';
import type {IAgentAssistantImageAttachment} from '@contracts/agent';
import type {TTranslateFn} from '@i18n-app';
import {useAssistantImageComposer} from '@app/modules/agent-panel/composables/useAssistantImageComposer';

const mocks = vi.hoisted(() => ({buildComposerImageAttachments: vi.fn()}));

vi.mock('@app/modules/agent-panel/utils/assistantImageAttachments', () => ({
    ASSISTANT_IMAGE_SIZE_LIMIT_LABEL: '10 MB',
    buildComposerImageAttachments: mocks.buildComposerImageAttachments,
    buildExpandedImagePreview: vi.fn(() => null),
    getClipboardImageFiles: (dataTransfer: DataTransfer | null) => Array.from(dataTransfer?.files ?? []),
    navigateExpandedImagePreview: vi.fn(),
}));

const translate = ((key: string) => key) as TTranslateFn;

function createImage(id: string): IAgentAssistantImageAttachment {
    return {
        type: 'image',
        id,
        name: `${id}.png`,
        mimeType: 'image/png',
        sizeBytes: 100,
        dataUrl: `data:image/png;base64,${id}`,
    };
}

function createFile(name: string) {
    return new File([new Uint8Array(100)], name, {type: 'image/png'});
}

function createPasteEvent(files: readonly File[], preventDefault = vi.fn()): ClipboardEvent {
    const dataTransfer = new DataTransfer();
    for (const file of files) {
        dataTransfer.items.add(file);
    }
    const event = new ClipboardEvent('paste', {clipboardData: dataTransfer});
    vi.spyOn(event, 'preventDefault').mockImplementation(preventDefault);
    return event;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return {
        promise,
        resolve,
    };
}

describe('assistant image composer', () => {
    let unmount: (() => void) | null = null;

    beforeEach(() => {
        mocks.buildComposerImageAttachments.mockReset();
    });

    afterEach(() => {
        unmount?.();
        unmount = null;
    });

    function mountComposer() {
        let composer: ReturnType<typeof useAssistantImageComposer> | null = null;
        let composerImages: Ref<IAgentAssistantImageAttachment[]> | null = null;
        let composerError: Ref<string> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const Harness = defineComponent({
            setup() {
                const images = ref<IAgentAssistantImageAttachment[]>([]);
                const error = ref('');
                composerImages = images;
                composerError = error;
                composer = useAssistantImageComposer({
                    composerError: error,
                    composerImages: images,
                    t: translate,
                });
                return () => h('textarea', {onPaste: composer?.handleComposerPaste});
            },
        });
        const app = createApp(Harness);
        app.mount(host);
        unmount = () => {
            app.unmount();
            host.remove();
        };
        return {
            composer: () => composer!,
            composerError: () => composerError!,
            composerImages: () => composerImages!,
        };
    }

    it('serializes rapid pastes and accumulates both attachments', async () => {
        const harness = mountComposer();
        const first = createDeferred<{
            images: IAgentAssistantImageAttachment[];
            error: null;
        }>();
        const firstImage = createImage('first');
        const secondImage = createImage('second');
        mocks.buildComposerImageAttachments
            .mockImplementationOnce(async ({existingImages}: {existingImages: readonly IAgentAssistantImageAttachment[]}) => {
                expect(existingImages).toEqual([]);
                return first.promise;
            })
            .mockImplementationOnce(async ({existingImages}: {existingImages: readonly IAgentAssistantImageAttachment[]}) => {
                expect(existingImages).toEqual([firstImage]);
                return {
                    images: [...existingImages, secondImage],
                    error: null,
                };
            });

        const preventDefault = vi.fn();
        harness.composer().handleComposerPaste(createPasteEvent([createFile('first.png')], preventDefault));
        harness.composer().handleComposerPaste(createPasteEvent([createFile('second.png')], preventDefault));
        await nextTick();

        expect(preventDefault).toHaveBeenCalledTimes(2);
        expect(harness.composer().isImageIngestionPending.value).toBe(true);
        first.resolve({
            images: [firstImage],
            error: null,
        });
        await vi.waitFor(() => {
            expect(harness.composer().isImageIngestionPending.value).toBe(false);
        });

        expect(mocks.buildComposerImageAttachments).toHaveBeenCalledTimes(2);
        expect(harness.composerImages().value).toEqual([firstImage, secondImage]);
    });

    it('drops stale image results and errors after the composer is invalidated', async () => {
        const harness = mountComposer();
        const pending = createDeferred<{
            images: IAgentAssistantImageAttachment[];
            error: {
                type: 'read-failed';
                name: string;
            };
        }>();
        mocks.buildComposerImageAttachments.mockReturnValueOnce(pending.promise);
        harness.composer().handleComposerPaste(createPasteEvent([createFile('stale.png')]));
        await nextTick();

        harness.composer().clearComposerImages();
        pending.resolve({
            images: [createImage('stale')],
            error: {
                type: 'read-failed',
                name: 'stale.png',
            },
        });
        await vi.waitFor(() => {
            expect(harness.composer().isImageIngestionPending.value).toBe(false);
        });

        expect(harness.composer().isImageIngestionPending.value).toBe(false);
        expect(harness.composerImages().value).toEqual([]);
        expect(harness.composerError().value).toBe('');
    });

    it('keeps an in-flight paste when an existing attachment is removed', async () => {
        const harness = mountComposer();
        const existingImage = createImage('existing');
        const pastedImage = createImage('pasted');
        const pending = createDeferred<{
            images: IAgentAssistantImageAttachment[];
            error: null;
        }>();
        harness.composerImages().value = [existingImage];
        mocks.buildComposerImageAttachments.mockReturnValueOnce(pending.promise);

        harness.composer().handleComposerPaste(createPasteEvent([createFile('pasted.png')]));
        await vi.waitFor(() => {
            expect(mocks.buildComposerImageAttachments).toHaveBeenCalledOnce();
        });

        harness.composer().removeComposerImage(existingImage.id);
        pending.resolve({
            images: [existingImage, pastedImage],
            error: null,
        });
        await vi.waitFor(() => {
            expect(harness.composer().isImageIngestionPending.value).toBe(false);
        });

        expect(harness.composerImages().value).toEqual([pastedImage]);
    });
});
