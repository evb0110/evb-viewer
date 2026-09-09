import {
    afterEach,
    beforeEach,
    vi,
} from 'vitest';

let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;
let vueRuntimeMessages: string[] = [];
let unexpectedErrorMessages: string[] = [];

function formatConsoleArgs(args: unknown[]) {
    return args
        .map(arg => {
            if (typeof arg === 'string') {
                return arg;
            }

            if (arg instanceof Error) {
                return arg.stack ?? arg.message;
            }

            try {
                return JSON.stringify(arg);
            }
            catch {
                return String(arg);
            }
        })
        .join(' ');
}

function isVueRuntimeFailure(message: string) {
    return message.includes('[Vue warn]')
        || message.includes('[Vue error]')
        || message.includes('Unhandled error during execution');
}

// Every console.error during a test is a failure. A test that exercises an
// error path installs its own `vi.spyOn(console, 'error').mockImplementation`
// and asserts on it, so silent error logging can no longer pass unnoticed.
beforeEach(() => {
    vueRuntimeMessages = [];
    unexpectedErrorMessages = [];

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        const message = formatConsoleArgs(args);
        if (isVueRuntimeFailure(message)) {
            vueRuntimeMessages.push(message);
        }
    });

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const message = formatConsoleArgs(args);
        if (isVueRuntimeFailure(message)) {
            vueRuntimeMessages.push(message);
        } else {
            unexpectedErrorMessages.push(message);
        }
    });
});

function formatFailureList(messages: string[]) {
    return messages
        .map(message => `- ${message}`)
        .join('\n');
}

afterEach(() => {
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    consoleWarnSpy = null;
    consoleErrorSpy = null;

    const vueFailures = vueRuntimeMessages;
    const errorFailures = unexpectedErrorMessages;
    vueRuntimeMessages = [];
    unexpectedErrorMessages = [];

    if (vueFailures.length > 0) {
        throw new Error(`Vue runtime warnings/errors are test failures:\n${formatFailureList(vueFailures)}`);
    }
    if (errorFailures.length > 0) {
        throw new Error(
            'Unexpected console.error output is a test failure; '
            + 'mock console.error in the test when the error path is intended:\n'
            + formatFailureList(errorFailures),
        );
    }
});
