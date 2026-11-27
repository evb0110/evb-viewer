export interface IAgentResourceUri {
    uri: string;
    host: string;
    parts: string[];
}

/**
 * The `evb://` scheme is a contract between the main-process MCP server, which
 * advertises the URIs, and the renderer workspace, which resolves the document
 * ones. Parsing them in one place keeps the two sides from disagreeing about
 * what a host or a path segment is after an encoded tab id round-trips.
 */
export function parseAgentResourceUri(uri: string): IAgentResourceUri {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error(`Invalid EVB resource URI: ${uri}`);
    }

    if (parsed.protocol !== 'evb:') {
        throw new Error(`Unsupported EVB resource URI protocol: ${parsed.protocol}`);
    }

    return {
        uri,
        host: parsed.hostname,
        parts: parsed.pathname
            .split('/')
            .filter(Boolean)
            .map((part) => decodeURIComponent(part)),
    };
}
