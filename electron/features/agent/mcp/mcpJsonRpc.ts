export type TJsonRpcId = string | number | null;

export interface IJsonRpcResponse {
    jsonrpc: '2.0';
    id: TJsonRpcId;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export function getJsonRpcId(value: unknown): TJsonRpcId {
    if (typeof value === 'string' || typeof value === 'number' || value === null) {
        return value;
    }
    return null;
}

export function createResultResponse(id: TJsonRpcId, result: unknown): IJsonRpcResponse {
    return {
        jsonrpc: '2.0',
        id,
        result,
    };
}

export function createErrorResponse(id: TJsonRpcId, code: number, message: string, data?: unknown): IJsonRpcResponse {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code,
            message,
            ...(data === undefined ? {} : {data}),
        },
    };
}
