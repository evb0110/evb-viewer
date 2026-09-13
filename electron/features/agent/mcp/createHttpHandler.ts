import type {
    IncomingMessage,
    ServerResponse,
} from 'http';
import {timingSafeEqual} from 'node:crypto';
import { getErrorMessage } from '@electron/utils/error';
import {
    createHealthResponse,
    processMcpRequest,
    type IProcessMcpRequestOptions,
} from '@electron/features/agent/mcp/mcpServerCore';
import {
    createErrorResponse,
    type IJsonRpcResponse,
} from '@electron/features/agent/mcp/mcpJsonRpc';

const MAX_JSON_RPC_BODY_BYTES = 1024 * 1024;
const MAX_JSON_RPC_BATCH_ITEMS = 32;

interface IHttpHandlerOptions {
    bearerToken?: string | null;
    allowUnauthenticated?: boolean;
    allowBrowserOrigins?: boolean;
    activeRequestControllers?: Map<AbortController, unknown>;
    getRequestContext?: () => unknown;
    createRequestOptions?: (context: unknown) => IProcessMcpRequestOptions;
}

function createRequestAbortController(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController();
    const abort = (reason: string) => {
        if (!controller.signal.aborted) {
            controller.abort(new Error(reason));
        }
    };
    request.once('aborted', () => abort('MCP HTTP request aborted'));
    request.once('close', () => {
        if (!request.complete) {
            abort('MCP HTTP request closed before its body completed');
        }
    });
    request.once('error', (error) => abort(getErrorMessage(error)));
    response.once('close', () => {
        if (!response.writableFinished) {
            abort('MCP HTTP response closed before it completed');
        }
    });
    response.once('error', (error) => abort(getErrorMessage(error)));
    return controller;
}

function throwIfRequestAborted(signal: AbortSignal) {
    if (!signal.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('MCP HTTP request was aborted.');
}

function withRequestAbortSignal(
    options: IProcessMcpRequestOptions,
    signal: AbortSignal,
): IProcessMcpRequestOptions {
    const requestOptions: IProcessMcpRequestOptions = {
        ...options,
        getWorkspaceSnapshot: async (windowId) => {
            throwIfRequestAborted(signal);
            const snapshot = await options.getWorkspaceSnapshot(windowId);
            throwIfRequestAborted(signal);
            return snapshot;
        },
        runCommand: async (command, windowId) => {
            throwIfRequestAborted(signal);
            const result = await options.runCommand(command, windowId, signal);
            throwIfRequestAborted(signal);
            return result;
        },
    };
    const inspectDocumentText = options.inspectDocumentText;
    if (inspectDocumentText) {
        requestOptions.inspectDocumentText = async (input, windowId) => {
            throwIfRequestAborted(signal);
            const result = await inspectDocumentText(input, windowId, signal);
            throwIfRequestAborted(signal);
            return result;
        };
    }
    const searchDocument = options.searchDocument;
    if (searchDocument) {
        requestOptions.searchDocument = async (input, windowId) => {
            throwIfRequestAborted(signal);
            const result = await searchDocument(input, windowId, signal);
            throwIfRequestAborted(signal);
            return result;
        };
    }
    const readDocumentPages = options.readDocumentPages;
    if (readDocumentPages) {
        requestOptions.readDocumentPages = async (input, windowId) => {
            throwIfRequestAborted(signal);
            const result = await readDocumentPages(input, windowId, signal);
            throwIfRequestAborted(signal);
            return result;
        };
    }
    return requestOptions;
}

function readRequestBody(request: IncomingMessage, signal: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
        let body = '';
        const handleAbort = () => reject(signal.reason instanceof Error
            ? signal.reason
            : new Error('MCP HTTP request was aborted.'));

        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > MAX_JSON_RPC_BODY_BYTES) {
                reject(new Error('JSON-RPC request body is too large.'));
                request.destroy();
            }
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
        signal.addEventListener('abort', handleAbort, {once: true});
    });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(payload));
}

function writeNoContent(response: ServerResponse) {
    response.writeHead(202, {'Cache-Control': 'no-store'});
    response.end();
}

function isAuthorizedMcpRequest(request: IncomingMessage, options: IHttpHandlerOptions) {
    const bearerToken = options.bearerToken;
    if (!bearerToken) {
        return options.allowUnauthenticated === true;
    }

    const header = request.headers.authorization;
    if (typeof header !== 'string') {
        return false;
    }
    const expected = Buffer.from(`Bearer ${bearerToken}`, 'utf8');
    const actual = Buffer.from(header, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isBrowserOriginMcpRequest(request: IncomingMessage) {
    return typeof request.headers.origin === 'string'
        || typeof request.headers.referer === 'string'
        || typeof request.headers['sec-fetch-site'] === 'string';
}

export function createHttpHandler(
    options: IProcessMcpRequestOptions,
    httpOptions: IHttpHandlerOptions = {},
) {
    return async (request: IncomingMessage, response: ServerResponse) => {
        const requestAbortController = createRequestAbortController(request, response);
        const requestContext = httpOptions.getRequestContext?.();
        httpOptions.activeRequestControllers?.set(requestAbortController, requestContext);
        const releaseRequestController = () => {
            httpOptions.activeRequestControllers?.delete(requestAbortController);
        };
        response.once('finish', releaseRequestController);
        response.once('close', releaseRequestController);
        const requestOptions = withRequestAbortSignal(
            httpOptions.createRequestOptions?.(requestContext) ?? options,
            requestAbortController.signal,
        );
        if (httpOptions.allowBrowserOrigins !== true && isBrowserOriginMcpRequest(request)) {
            writeJson(response, 403, { error: 'Browser-origin MCP requests are not allowed.' });
            return;
        }

        if (request.method === 'GET' && request.url === '/health') {
            if (!isAuthorizedMcpRequest(request, httpOptions)) {
                writeJson(response, 401, { error: 'Unauthorized.' });
                return;
            }
            writeJson(response, 200, createHealthResponse(options.identity));
            return;
        }

        if (request.method !== 'POST') {
            writeJson(response, 405, { error: 'Only POST JSON-RPC requests are supported.' });
            return;
        }

        if (!isAuthorizedMcpRequest(request, httpOptions)) {
            writeJson(response, 401, { error: 'Unauthorized.' });
            return;
        }

        try {
            const body = await readRequestBody(request, requestAbortController.signal);
            const parsed: unknown = JSON.parse(body);
            if (Array.isArray(parsed)) {
                if (parsed.length > MAX_JSON_RPC_BATCH_ITEMS) {
                    writeJson(response, 400, createErrorResponse(null, -32600, 'JSON-RPC batch is too large.'));
                    return;
                }
                const processedResponses: Array<IJsonRpcResponse | null> = [];
                for (const item of parsed) {
                    processedResponses.push(await processMcpRequest(item, requestOptions));
                }
                const responses: IJsonRpcResponse[] = [];
                for (const item of processedResponses) {
                    if (item !== null) {
                        responses.push(item);
                    }
                }

                if (responses.length === 0) {
                    writeNoContent(response);
                    return;
                }
                writeJson(response, 200, responses);
                return;
            }

            const result = await processMcpRequest(parsed, requestOptions);
            if (!result) {
                writeNoContent(response);
                return;
            }
            writeJson(response, 200, result);
        } catch (error) {
            if (response.destroyed) {
                return;
            }
            const message = error instanceof SyntaxError
                ? 'Invalid JSON-RPC request body.'
                : getErrorMessage(error);
            writeJson(response, 400, createErrorResponse(null, -32700, message));
        }
    };
}
