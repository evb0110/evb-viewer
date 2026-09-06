const BASE64URL_PATTERN = /^[\w-]+$/u;

export function decodeBase64UrlUtf8(value: string) {
    if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
        return null;
    }

    const paddedValue = value
        .replace(/-/gu, '+')
        .replace(/_/gu, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
    let binary: string;
    try {
        binary = atob(paddedValue);
    } catch {
        return null;
    }

    const canonicalValue = btoa(binary)
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/u, '');
    if (canonicalValue !== value) {
        return null;
    }

    try {
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
        return null;
    }
}
