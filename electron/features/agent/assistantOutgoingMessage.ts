import { randomUUID } from 'crypto';
import type {
    IAgentAssistantImageAttachment,
    IAgentAssistantSendMessageRequest,
} from '@contracts/agent';
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
} from '@contracts/agent';

interface IParsedAssistantImageDataUrl {
    base64: string;
    mimeType: string;
    sizeBytes: number;
}

interface INormalizeOutgoingAttachmentsOptions {createId?: () => string;}

export function estimateBase64ByteSize(base64: string) {
    const padding = base64.endsWith('==')
        ? 2
        : base64.endsWith('=')
            ? 1
            : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
}

export function parseAssistantImageDataUrl(dataUrl: string): IParsedAssistantImageDataUrl | null {
    const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/iu.exec(dataUrl.trim());
    if (!match) {
        return null;
    }

    const headerParts = match[1]!.split(';').map(part => part.trim().toLowerCase()).filter(Boolean);
    const mimeType = headerParts[0] ?? '';
    if (!mimeType.startsWith('image/') || !headerParts.includes('base64')) {
        return null;
    }

    const base64 = match[2]!.replace(/\s+/gu, '');
    if (!base64 || !/^[a-z0-9+/]+={0,2}$/iu.test(base64)) {
        return null;
    }

    const sizeBytes = estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > ASSISTANT_MAX_IMAGE_BYTES) {
        return null;
    }

    return {
        base64,
        mimeType,
        sizeBytes,
    };
}

export function normalizeAssistantAttachmentName(name: string, index: number) {
    return name.trim().slice(0, 160) || `image-${index + 1}`;
}

export function normalizeOutgoingAttachments(
    request: IAgentAssistantSendMessageRequest,
    options: INormalizeOutgoingAttachmentsOptions = {},
) {
    const rawAttachments = Array.isArray(request.attachments) ? request.attachments : [];
    if (rawAttachments.length > ASSISTANT_MAX_IMAGE_ATTACHMENTS) {
        throw new Error(`EVB Assistant accepts up to ${ASSISTANT_MAX_IMAGE_ATTACHMENTS} images per message.`);
    }

    return rawAttachments.map((attachment, index): IAgentAssistantImageAttachment => {
        const parsed = parseAssistantImageDataUrl(attachment.dataUrl);
        if (!parsed) {
            throw new Error('One attached image is invalid or too large.');
        }

        return {
            type: 'image',
            id: attachment.id.trim() || (options.createId ?? randomUUID)(),
            name: normalizeAssistantAttachmentName(attachment.name, index),
            mimeType: parsed.mimeType,
            sizeBytes: parsed.sizeBytes,
            dataUrl: `data:${parsed.mimeType};base64,${parsed.base64}`,
        };
    });
}

export function normalizeOutgoingMessageRequest(
    request: IAgentAssistantSendMessageRequest,
    options: INormalizeOutgoingAttachmentsOptions = {},
) {
    return {
        text: typeof request.text === 'string' ? request.text.trim() : '',
        attachments: normalizeOutgoingAttachments(request, options),
    };
}
