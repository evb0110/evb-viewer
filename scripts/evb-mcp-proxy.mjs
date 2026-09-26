#!/usr/bin/env node

import process from 'node:process';

const DEFAULT_EVB_MCP_HOST = '127.0.0.1';
const DEFAULT_EVB_MCP_PORT = '38672';
const EVB_MCP_REQUEST_TIMEOUT_MS = 300_000;
const EVB_MCP_URL = resolveTargetUrl();
const EVB_MCP_TOKEN = process.env.EVB_MCP_TOKEN?.trim() || '';

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
    inputBuffer = Buffer.concat([
        inputBuffer,
        chunk,
    ]);
    void processInputBuffer();
});
process.stdin.on('error', (error) => {
    process.stderr.write(`[evb-mcp-proxy] stdin error: ${getErrorMessage(error)}\n`);
});

async function processInputBuffer() {
    while (true) {
        let message;
        try {
            message = readNextMessage();
        } catch (error) {
            writeMessage(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: getErrorMessage(error),
                },
            }));
            continue;
        }
        if (message === null) {
            return;
        }
        if (message.length === 0) {
            continue;
        }

        try {
            const response = await forwardMessage(message);
            if (response.length > 0) {
                writeMessage(response);
            }
        } catch (error) {
            const messageText = `EVB Viewer MCP endpoint is unavailable at ${EVB_MCP_URL}: ${getErrorMessage(error)}`;
            for (const id of getRequestIds(message)) {
                writeMessage(JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32603,
                        message: messageText,
                    },
                }));
            }
        }
    }
}

async function forwardMessage(message) {
    const headers = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(EVB_MCP_TOKEN ? {authorization: `Bearer ${EVB_MCP_TOKEN}`} : {}),
    };

    const response = await fetch(EVB_MCP_URL, {
        method: 'POST',
        headers,
        body: message,
        signal: AbortSignal.timeout(EVB_MCP_REQUEST_TIMEOUT_MS),
    });
    return Buffer.from(await response.arrayBuffer());
}

function getRequestIds(message) {
    let payload;
    try {
        payload = JSON.parse(message.toString('utf8'));
    } catch {
        return [null];
    }

    const requests = Array.isArray(payload) ? payload : [payload];
    return requests.flatMap((request) => {
        if (request === null || typeof request !== 'object' || !Object.hasOwn(request, 'id')) {
            return [];
        }
        const {id} = request;
        return id === null || typeof id === 'string' || typeof id === 'number'
            ? [id]
            : [null];
    });
}

function readNextMessage() {
    if (inputBuffer.length === 0) {
        return null;
    }

    if (startsWithContentLengthHeader(inputBuffer)) {
        return readNextHeaderFramedMessage();
    }

    const lineEnd = inputBuffer.indexOf('\n');
    if (lineEnd < 0) {
        return null;
    }

    let line = inputBuffer.subarray(0, lineEnd);
    inputBuffer = inputBuffer.subarray(lineEnd + 1);
    if (line.at(-1) === 13) {
        line = line.subarray(0, -1);
    }
    return line;
}

function readNextHeaderFramedMessage() {
    const headerEnd = findHeaderEnd(inputBuffer);
    if (!headerEnd) {
        return null;
    }
    const headerText = inputBuffer.subarray(0, headerEnd.index).toString('utf8');
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(headerText);
    if (!contentLengthMatch) {
        inputBuffer = inputBuffer.subarray(headerEnd.index + headerEnd.length);
        throw new Error('MCP stdio message is missing Content-Length header.');
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd.index + headerEnd.length;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
        return null;
    }

    const body = inputBuffer.subarray(bodyStart, bodyEnd);
    inputBuffer = inputBuffer.subarray(bodyEnd);
    return body;
}

function findHeaderEnd(buffer) {
    const crlfIndex = buffer.indexOf('\r\n\r\n');
    if (crlfIndex >= 0) {
        return {
            index: crlfIndex,
            length: 4,
        };
    }

    const lfIndex = buffer.indexOf('\n\n');
    if (lfIndex >= 0) {
        return {
            index: lfIndex,
            length: 2,
        };
    }
    return null;
}

function writeMessage(message) {
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
    process.stdout.write(payload);
    if (payload.at(-1) !== 10) {
        process.stdout.write('\n');
    }
}

function startsWithContentLengthHeader(buffer) {
    return buffer.subarray(0, Math.min(buffer.length, 16)).toString('ascii').toLowerCase().startsWith('content-length:');
}

function resolveTargetUrl() {
    const urlArgIndex = process.argv.indexOf('--url');
    const urlArg = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : undefined;
    const explicitUrl = urlArg?.trim() || process.env.EVB_MCP_URL?.trim();
    if (explicitUrl) {
        return explicitUrl;
    }

    const host = process.env.EVB_MCP_HOST?.trim() || DEFAULT_EVB_MCP_HOST;
    const port = process.env.EVB_MCP_PORT?.trim() || DEFAULT_EVB_MCP_PORT;
    return `http://${host}:${port}`;
}

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
