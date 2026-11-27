type TProcessEnv = Record<string, string | undefined>;

interface IRuntimeGlobal {
    process?: {env?: TProcessEnv};
}

export function getRuntimeEnv(): TProcessEnv {
    return (globalThis as typeof globalThis & IRuntimeGlobal).process?.env ?? {};
}

export function firstNonEmptyStringPreservingWhitespace(values: ReadonlyArray<string | undefined>) {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return '';
}

export function firstNonWhitespaceString(values: ReadonlyArray<string | undefined>) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }

    return '';
}
