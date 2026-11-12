import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
} from '@contracts/agent';
import {
    estimateBase64ByteSize,
    normalizeAssistantAttachmentName,
    normalizeOutgoingAttachments,
    normalizeOutgoingMessageRequest,
    parseAssistantImageDataUrl,
} from '@electron/features/agent/assistantOutgoingMessage';

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8=';

describe('assistantOutgoingMessage', () => {
    it('estimates base64 byte sizes with padding', () => {
        expect(estimateBase64ByteSize('aGVsbG8=')).toBe(5);
        expect(estimateBase64ByteSize('YQ==')).toBe(1);
        expect(estimateBase64ByteSize('YWJj')).toBe(3);
    });

    it('parses and normalizes valid image data URLs', () => {
        expect(parseAssistantImageDataUrl(' data:IMAGE/PNG ; BASE64 , aG Vs\nbG8= ')).toEqual({
            base64: 'aGVsbG8=',
            mimeType: 'image/png',
            sizeBytes: 5,
        });
    });

    it('rejects non-image, non-base64, invalid, empty, and oversized data URLs', () => {
        expect(parseAssistantImageDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull();
        expect(parseAssistantImageDataUrl('data:image/png,aGVsbG8=')).toBeNull();
        expect(parseAssistantImageDataUrl('data:image/png;base64,***')).toBeNull();
        expect(parseAssistantImageDataUrl('data:image/png;base64,')).toBeNull();
        expect(parseAssistantImageDataUrl(`data:image/png;base64,${'a'.repeat(Math.ceil((ASSISTANT_MAX_IMAGE_BYTES + 1) / 3) * 4)}`)).toBeNull();
    });

    it('normalizes outgoing attachments with fallback ids and bounded names', () => {
        const normalized = normalizeOutgoingAttachments({
            text: 'hello',
            attachments: [{
                type: 'image',
                id: '',
                name: ` ${'x'.repeat(180)} `,
                mimeType: 'image/png',
                sizeBytes: 0,
                dataUrl: 'data:image/png;BASE64, aG Vs bG8= ',
            }],
        }, {createId: () => 'fallback-id'});

        expect(normalized).toEqual([{
            type: 'image',
            id: 'fallback-id',
            name: 'x'.repeat(160),
            mimeType: 'image/png',
            sizeBytes: 5,
            dataUrl: 'data:image/png;base64,aGVsbG8=',
        }]);
    });

    it('rejects too many outgoing attachments and invalid image payloads', () => {
        const attachments = Array.from({ length: ASSISTANT_MAX_IMAGE_ATTACHMENTS + 1 }, () => ({
            type: 'image' as const,
            id: 'id',
            name: 'image.png',
            mimeType: 'image/png',
            sizeBytes: 5,
            dataUrl: PNG_DATA_URL,
        }));

        expect(() => normalizeOutgoingAttachments({
            text: '',
            attachments,
        })).toThrow(`EVB Assistant accepts up to ${ASSISTANT_MAX_IMAGE_ATTACHMENTS} images per message.`);
        expect(() => normalizeOutgoingAttachments({
            text: '',
            attachments: [{
                type: 'image',
                id: 'id',
                name: 'image.png',
                mimeType: 'image/png',
                sizeBytes: 5,
                dataUrl: 'data:text/plain;base64,aGVsbG8=',
            }],
        })).toThrow('One attached image is invalid or too large.');
    });

    it('trims outgoing text and normalizes attachment names', () => {
        expect(normalizeAssistantAttachmentName('', 2)).toBe('image-3');
        expect(normalizeOutgoingMessageRequest({
            text: '  hello  ',
            attachments: [{
                type: 'image',
                id: 'image-id',
                name: ' image.png ',
                mimeType: 'image/png',
                sizeBytes: 5,
                dataUrl: PNG_DATA_URL,
            }],
        })).toEqual({
            text: 'hello',
            attachments: [{
                type: 'image',
                id: 'image-id',
                name: 'image.png',
                mimeType: 'image/png',
                sizeBytes: 5,
                dataUrl: PNG_DATA_URL,
            }],
        });
    });
});
