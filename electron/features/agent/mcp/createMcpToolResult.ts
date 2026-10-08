import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';

interface IMcpToolTextContent {
    type: 'text';
    text: string;
}

interface IMcpToolImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}

type TMcpToolContent = IMcpToolTextContent | IMcpToolImageContent;

function getMcpImagePayload(data: unknown) {
    if (!isRecord(data) || !isRecord(data.image)) {
        return null;
    }

    const { image } = data;
    return typeof image.data === 'string'
        && image.data.trim().length > 0
        && typeof image.mimeType === 'string'
        && image.mimeType.trim().startsWith('image/')
        ? {
            data: image.data.trim(),
            mimeType: image.mimeType.trim(),
        }
        : null;
}

function createToolStructuredContent(data: unknown) {
    if (!isRecord(data) || !isRecord(data.image)) {
        return data;
    }

    const imageMetadata = Object.fromEntries(
        Object.entries(data.image).filter(([key]) => key !== 'data'),
    );
    return {
        ...data,
        image: imageMetadata,
    };
}

export function createMcpToolResult(data: unknown) {
    const structuredContent = createToolStructuredContent(data);
    const content: TMcpToolContent[] = [{
        type: 'text',
        text: JSON.stringify(structuredContent),
    }];
    const image = getMcpImagePayload(data);
    if (image) {
        content.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
        });
    }

    return {
        content,
        structuredContent,
    };
}

function createMcpToolErrorResult(
    code: string,
    message: string,
    capabilityId: string | null,
) {
    const structuredContent = {
        code,
        message,
        capabilityId,
    };
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify(structuredContent),
        }],
        isError: true,
        structuredContent,
    };
}

export function createMcpToolExecutionErrorResult(error: unknown, params: unknown) {
    const capabilityId = isRecord(params) && typeof params.id === 'string' ? params.id : null;
    return createMcpToolErrorResult('tool_execution_failed', getErrorMessage(error), capabilityId);
}
