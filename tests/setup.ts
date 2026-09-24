import { realpathSync } from 'node:fs';
import {
    devNull,
    tmpdir,
} from 'node:os';
import {
    afterEach,
    beforeEach,
    vi,
} from 'vitest';

// Tests that spawn git build fixture repositories under the temp directory and
// must never reach the checkout that runs them. A git hook exports GIT_DIR and
// related variables, which would send every fixture `git config` and `git commit`
// to the real repository; that is how fixture identities reached real commits.
// Drop those variables, keep global and system config out, and stop repository
// discovery at the temp directory so a fixture without its own repository fails
// instead of resolving to an enclosing checkout.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
delete process.env.GIT_COMMON_DIR;
delete process.env.GIT_OBJECT_DIRECTORY;
delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
delete process.env.GIT_NAMESPACE;
delete process.env.GIT_PREFIX;
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

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
