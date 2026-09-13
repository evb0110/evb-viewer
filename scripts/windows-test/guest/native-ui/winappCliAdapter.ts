import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IGuestClock,
    IGuestCommandResult,
    IGuestCommandRunner,
} from '@scripts/windows-test/guest/guestRuntime';
import {
    createNativeUiActionLog,
    DesktopUnavailableError,
    selectorNameCandidates,
    waitForUniqueControl,
    type INativeUiActionLog,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';

// Pinned by the M0b selection gate. The command and JSON schemas in this
// adapter are for this exact release.
export const WINAPP_EXPECTED_VERSION = '0.6.0';

export const WINAPP_DEFAULT_EXECUTABLE = 'winapp.exe';

// Keep this list limited to commands that exist in the pinned WinApp CLI.
// There is no uia, find-window, find-elements, dump-tree, or select command
// in v0.6.0.
export const winappCommands = {
    version: ['--version'],
    status: [
        'ui',
        'status',
    ],
    inspect: [
        'ui',
        'inspect',
    ],
    search: [
        'ui',
        'search',
    ],
    invoke: [
        'ui',
        'invoke',
    ],
    setValue: [
        'ui',
        'set-value',
    ],
    sendKeys: [
        'ui',
        'send-keys',
    ],
    listWindows: [
        'ui',
        'list-windows',
    ],
    screenshot: [
        'ui',
        'screenshot',
    ],
} as const;

const WINAPP_SEARCH_MAX_RESULTS = 1_000;
const WINAPP_INSPECT_DEPTH = 64;

export interface IWinappElementPayload {
    selector?: string | null;
    type: string;
    name?: string | null;
    automationId?: string | null;
    children?: IWinappElementPayload[] | null;
}

export interface IWinappSearchPayload {
    matchCount: number;
    hasMore: boolean;
    matches: IWinappElementPayload[];
}

export interface IWinappInspectWindowPayload {
    hwnd: number;
    title?: string | null;
    className?: string | null;
    elementCount: number;
    elements: IWinappElementPayload[];
}

export interface IWinappInspectPayload {
    depth: number;
    interactive: boolean;
    hideDisabled: boolean;
    hideOffscreen: boolean;
    windows: IWinappInspectWindowPayload[];
}

export interface IWinappWindowPayload {
    hwnd: number;
    processId: number;
    processName: string;
    title?: string | null;
    label?: string | null;
    width: number;
    height: number;
    ownerHwnd: number;
    className?: string | null;
    isForeground: boolean;
}

export interface IWinappStatusPayload {
    processId: number;
    processName: string;
    windowTitle?: string | null;
    hwnd: number;
}

export interface IWinappInvokePayload {
    elementId: string;
    pattern: string;
    hwnd: number;
}

export interface IWinappSetValuePayload {
    elementId: string;
    hwnd: number;
}

export interface IWinappSendKeysPayload {
    keys: string;
    via: string;
    actionCount: number;
    target?: string | null;
    hwnd: number;
    warnings?: string[] | null;
}

export interface IWinappScreenshotPayload {
    elementId?: string | null;
    filePath: string;
    width: number;
    height: number;
    processId: number;
    windowTitle?: string | null;
    hwnd: number;
}

function isOptionalString(value: unknown) {
    return value === undefined || value === null || typeof value === 'string';
}

function isOptionalChildren(value: unknown): value is IWinappElementPayload[] | null | undefined {
    return value === undefined
        || value === null
        || (Array.isArray(value) && value.every(isWinappElementPayload));
}

export function isWinappElementPayload(value: unknown): value is IWinappElementPayload {
    return isRecord(value)
        && (value.selector === undefined || value.selector === null || (
            typeof value.selector === 'string' && value.selector.length > 0
        ))
        && typeof value.type === 'string'
        && value.type.length > 0
        && isOptionalString(value.name)
        && isOptionalString(value.automationId)
        && isOptionalChildren(value.children);
}

function parseJson(stdout: string, description: string): unknown {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
        throw new Error('winapp CLI returned empty output for ' + description);
    }
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        throw new Error(
            'winapp CLI returned output that is not JSON for '
            + description
            + ': '
            + trimmed.slice(0, 200),
        );
    }
}

function toActionableUiElementRef(payload: IWinappElementPayload, processId: number | null = null) {
    if (payload.selector === undefined || payload.selector === null || payload.selector.length === 0) {
        throw new Error(
            'winapp CLI returned an element without a semantic selector: '
            + JSON.stringify(payload),
        );
    }
    return {
        handle: payload.selector,
        controlType: payload.type,
        name: payload.name ?? '',
        automationId: payload.automationId ?? null,
        processId,
    } satisfies IUiElementRef;
}

export function toUiElementRef(payload: IWinappElementPayload): IUiElementRef {
    return toActionableUiElementRef(payload, null);
}

function isWinappSearchPayload(value: unknown): value is IWinappSearchPayload {
    return isRecord(value)
        && isFiniteNumber(value.matchCount)
        && typeof value.hasMore === 'boolean'
        && Array.isArray(value.matches)
        && value.matches.every(isWinappElementPayload);
}

export function parseWinappSearchPayload(stdout: string): IWinappSearchPayload {
    const parsed = parseJson(stdout, 'ui search');
    if (!isWinappSearchPayload(parsed)) {
        throw new Error('winapp CLI JSON did not contain a ui search result');
    }
    return parsed;
}

export function parseWinappElements(stdout: string): IUiElementRef[] {
    return parseWinappSearchPayload(stdout).matches.map(toUiElementRef);
}

function isWinappInspectWindowPayload(value: unknown): value is IWinappInspectWindowPayload {
    return isRecord(value)
        && isFiniteNumber(value.hwnd)
        && isOptionalString(value.title)
        && isOptionalString(value.className)
        && isFiniteNumber(value.elementCount)
        && Array.isArray(value.elements)
        && value.elements.every(isWinappElementPayload);
}

function isWinappInspectPayload(value: unknown): value is IWinappInspectPayload {
    return isRecord(value)
        && isFiniteNumber(value.depth)
        && typeof value.interactive === 'boolean'
        && typeof value.hideDisabled === 'boolean'
        && typeof value.hideOffscreen === 'boolean'
        && Array.isArray(value.windows)
        && value.windows.every(isWinappInspectWindowPayload);
}

export function parseWinappInspectPayload(stdout: string): IWinappInspectPayload {
    const parsed = parseJson(stdout, 'ui inspect');
    if (!isWinappInspectPayload(parsed)) {
        throw new Error('winapp CLI JSON did not contain a ui inspect result');
    }
    return parsed;
}

function isWinappWindowPayload(value: unknown): value is IWinappWindowPayload {
    return isRecord(value)
        && isFiniteNumber(value.hwnd)
        && isFiniteNumber(value.processId)
        && typeof value.processName === 'string'
        && isOptionalString(value.title)
        && isOptionalString(value.label)
        && isFiniteNumber(value.width)
        && isFiniteNumber(value.height)
        && isFiniteNumber(value.ownerHwnd)
        && isOptionalString(value.className)
        && typeof value.isForeground === 'boolean';
}

export function parseWinappWindows(stdout: string): IWinappWindowPayload[] {
    const parsed = parseJson(stdout, 'ui list-windows');
    if (!Array.isArray(parsed) || !parsed.every(isWinappWindowPayload)) {
        throw new Error('winapp CLI JSON did not contain a ui list-windows result');
    }
    return parsed;
}

function parseActionPayload<T>(
    stdout: string,
    description: string,
    isPayload: (value: unknown) => value is T,
) {
    const parsed = parseJson(stdout, description);
    if (!isPayload(parsed)) {
        throw new Error('winapp CLI JSON did not contain a ' + description + ' result');
    }
    return parsed;
}

function isWinappStatusPayload(value: unknown): value is IWinappStatusPayload {
    return isRecord(value)
        && isFiniteNumber(value.processId)
        && typeof value.processName === 'string'
        && isOptionalString(value.windowTitle)
        && isFiniteNumber(value.hwnd);
}

function isWinappInvokePayload(value: unknown): value is IWinappInvokePayload {
    return isRecord(value)
        && typeof value.elementId === 'string'
        && typeof value.pattern === 'string'
        && isFiniteNumber(value.hwnd);
}

function isWinappSetValuePayload(value: unknown): value is IWinappSetValuePayload {
    return isRecord(value)
        && typeof value.elementId === 'string'
        && isFiniteNumber(value.hwnd);
}

function isWinappSendKeysPayload(value: unknown): value is IWinappSendKeysPayload {
    return isRecord(value)
        && typeof value.keys === 'string'
        && typeof value.via === 'string'
        && isFiniteNumber(value.actionCount)
        && isOptionalString(value.target)
        && isFiniteNumber(value.hwnd)
        && (value.warnings === undefined
            || value.warnings === null
            || (Array.isArray(value.warnings) && value.warnings.every(item => typeof item === 'string')));
}

function isWinappScreenshotPayload(value: unknown): value is IWinappScreenshotPayload {
    return isRecord(value)
        && isOptionalString(value.elementId)
        && typeof value.filePath === 'string'
        && value.filePath.length > 0
        && isFiniteNumber(value.width)
        && isFiniteNumber(value.height)
        && isFiniteNumber(value.processId)
        && isOptionalString(value.windowTitle)
        && isFiniteNumber(value.hwnd);
}

export function parseWinappStatusPayload(stdout: string) {
    return parseActionPayload(stdout, 'ui status', isWinappStatusPayload);
}

export function parseWinappInvokePayload(stdout: string) {
    return parseActionPayload(stdout, 'ui invoke', isWinappInvokePayload);
}

export function parseWinappSetValuePayload(stdout: string) {
    return parseActionPayload(stdout, 'ui set-value', isWinappSetValuePayload);
}

export function parseWinappSendKeysPayload(stdout: string) {
    return parseActionPayload(stdout, 'ui send-keys', isWinappSendKeysPayload);
}

export function parseWinappScreenshotPayload(stdout: string) {
    return parseActionPayload(stdout, 'ui screenshot', isWinappScreenshotPayload);
}

function parseInspectElements(
    payload: IWinappInspectPayload,
    processId: number | null,
): Array<{
    element: IUiElementRef;
    windowHandle: string
}> {
    const matches: Array<{
        element: IUiElementRef;
        windowHandle: string
    }> = [];
    const visit = (elements: IWinappElementPayload[], windowHandle: string) => {
        for (const element of elements) {
            if (element.selector !== undefined && element.selector !== null && element.selector.length > 0) {
                matches.push({
                    element: toActionableUiElementRef(element, processId),
                    windowHandle,
                });
            }
            if (element.children !== undefined && element.children !== null) {
                visit(element.children, windowHandle);
            }
        }
    };
    for (const window of payload.windows) {
        visit(window.elements, String(window.hwnd));
    }
    return matches;
}

export function parseWinappInspectElements(stdout: string): IUiElementRef[] {
    return parseInspectElements(parseWinappInspectPayload(stdout), null).map(match => match.element);
}

export function parseWinappVersion(stdout: string) {
    const match = /(?:^|[\s:v])(\d+\.\d+\.\d+)(?=$|[\s.,;)])/mu.exec(stdout);
    if (match?.[1] === undefined) {
        throw new Error('winapp CLI did not report a version: ' + stdout.trim().slice(0, 120));
    }
    return match[1];
}

const desktopUnavailableHints = [
    'interactive desktop',
    'input desktop',
    'winsta0',
    'session 0',
    'desktop is locked',
    'no_interactive_desktop',
    'locked workstation',
] as const;

export function isDesktopUnavailableMessage(text: string) {
    const normalized = text.toLowerCase();
    return desktopUnavailableHints.some(hint => normalized.includes(hint));
}

function assertCommandSucceeded(result: IGuestCommandResult, description: string) {
    if (result.exitCode === 0) {
        return result;
    }
    const message = result.stderr + '\n' + result.stdout;
    if (isDesktopUnavailableMessage(message)) {
        throw new DesktopUnavailableError(
            description + ' reported ' + message.trim().slice(0, 200),
        );
    }
    throw new Error(
        'winapp CLI '
        + description
        + ' failed with exit '
        + result.exitCode
        + ': '
        + JSON.stringify({
            stdout: result.stdout,
            stderr: result.stderr,
        }),
    );
}

function matchesSelectorName(element: IUiElementRef, selector: IUiSelector) {
    const names = selectorNameCandidates(selector);
    return names.length === 0 || names.includes(element.name);
}

function matchesSelector(element: IUiElementRef, selector: IUiSelector) {
    return element.controlType === selector.controlType
        && (selector.automationId === undefined || element.automationId === selector.automationId)
        && matchesSelectorName(element, selector)
        && (selector.processId === undefined || element.processId === selector.processId);
}

function matchesSelectorPayload(
    payload: IWinappElementPayload,
    selector: IUiSelector,
    processId: number | null,
) {
    const names = selectorNameCandidates(selector);
    return payload.type === selector.controlType
        && (selector.automationId === undefined || payload.automationId === selector.automationId)
        && (names.length === 0 || names.includes(payload.name ?? ''))
        && (selector.processId === undefined
            || processId === null
            || selector.processId === processId);
}

function uniqueElements(elements: readonly IUiElementRef[]) {
    const seen = new Set<string>();
    return elements.filter(element => {
        if (seen.has(element.handle)) {
            return false;
        }
        seen.add(element.handle);
        return true;
    });
}

function requireCompleteSearch(payload: IWinappSearchPayload, operation: string) {
    if (payload.hasMore) {
        throw new UnsupportedWinappOperationError(
            operation,
            'ui search truncated its result set; the match list is not complete',
        );
    }
    return payload;
}

const legacyNamedKeys: Readonly<Record<string, string>> = {
    BACK: 'backspace',
    BACKSPACE: 'backspace',
    DELETE: 'delete',
    DEL: 'delete',
    DOWN: 'down',
    END: 'end',
    ENTER: 'enter',
    ESC: 'esc',
    ESCAPE: 'esc',
    HOME: 'home',
    LEFT: 'left',
    PAGEDOWN: 'pagedown',
    PAGEUP: 'pageup',
    RETURN: 'enter',
    RIGHT: 'right',
    SPACE: 'space',
    TAB: 'tab',
    UP: 'up',
};

function legacyKeyName(value: string) {
    const normalized = value.toUpperCase();
    const mapped = legacyNamedKeys[normalized];
    if (mapped !== undefined) {
        return mapped;
    }
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(normalized)) {
        return normalized.toLowerCase();
    }
    return undefined;
}

function encodeWinappText(value: string) {
    return 'text=' + value
        .replace(/\\/gu, '\\\\')
        .replace(/\t/gu, '\\t')
        .replace(/\r/gu, '\\r')
        .replace(/\n/gu, '\\n')
        .replace(/ /gu, '\\s');
}

function translateBracedSendKeys(keys: string) {
    const tokens: string[] = [];
    let literal = '';
    const flushLiteral = () => {
        if (literal.length > 0) {
            tokens.push(encodeWinappText(literal));
            literal = '';
        }
    };
    for (let index = 0; index < keys.length;) {
        if (keys[index] !== '{') {
            literal += keys[index] ?? '';
            index += 1;
            continue;
        }
        const close = keys.indexOf('}', index + 1);
        if (close < 0) {
            literal += keys[index] ?? '';
            index += 1;
            continue;
        }
        const body = keys.slice(index + 1, close);
        const mapped = legacyKeyName(body);
        if (mapped !== undefined) {
            flushLiteral();
            tokens.push(mapped);
        } else if (body.length === 1) {
            literal += body;
        } else {
            // Unknown brace expressions are literal in the worker's escaped
            // path strings. Preserve them instead of inventing a WinApp key.
            literal += '{' + body + '}';
        }
        index = close + 1;
    }
    flushLiteral();
    return tokens.join(' ');
}

function translateModifierSendKeys(keys: string) {
    const tokens: string[] = [];
    let index = 0;
    while (index < keys.length) {
        const modifiers: string[] = [];
        if (keys[index] === '~') {
            tokens.push('enter');
            index += 1;
            continue;
        }
        while (index < keys.length) {
            const modifier = keys[index];
            if (modifier === '^') {
                modifiers.push('ctrl');
            } else if (modifier === '+') {
                modifiers.push('shift');
            } else if (modifier === '%') {
                modifiers.push('alt');
            } else {
                break;
            }
            index += 1;
        }
        if (modifiers.length === 0) {
            const remainder = keys.slice(index);
            if (remainder.length > 0) {
                tokens.push(encodeWinappText(remainder));
            }
            break;
        }
        if (index >= keys.length) {
            tokens.push(modifiers.join('+'));
            break;
        }
        let key = keys[index] ?? '';
        if (key === '{') {
            const close = keys.indexOf('}', index + 1);
            if (close >= 0) {
                const body = keys.slice(index + 1, close);
                key = legacyKeyName(body) ?? body;
                index = close + 1;
            } else {
                index += 1;
            }
        } else {
            index += 1;
        }
        const mappedKey = legacyKeyName(key) ?? key.toLowerCase();
        tokens.push(modifiers.concat(mappedKey).join('+'));
    }
    return tokens.join(' ');
}

/**
 * The worker's portable dialog helpers use .NET SendKeys notation. WinApp
 * accepts named tokens such as enter and combos such as ctrl+o, so adapt only
 * that boundary. Plain WinApp strings pass through unchanged.
 */
export function translateLegacySendKeys(keys: string) {
    if (/^[+^%~]/u.test(keys)) {
        return translateModifierSendKeys(keys);
    }
    if (/\{[^{}]*\}/u.test(keys)) {
        return translateBracedSendKeys(keys);
    }
    return keys;
}

export interface ICreateWinappCliAdapterOptions {
    exec: IGuestCommandRunner;
    clock: IGuestClock;
    executable?: string;
    actionLog?: INativeUiActionLog;
    commandTimeoutMs?: number;
}

export class UnsupportedWinappOperationError extends Error {
    constructor(operation: string, reason: string) {
        super('WinApp CLI cannot perform ' + operation + ': ' + reason);
        this.name = 'UnsupportedWinappOperationError';
    }
}

export function createWinappCliAdapter({
    exec,
    clock,
    executable = WINAPP_DEFAULT_EXECUTABLE,
    actionLog = createNativeUiActionLog(),
    commandTimeoutMs = 60_000,
}: ICreateWinappCliAdapterOptions): INativeUiAdapter {
    const elementWindowHandles = new WeakMap<IUiElementRef, string>();
    let lastWindowRef: IUiElementRef | null = null;
    let screenshotWindowRef: IUiElementRef | null = null;

    const run = async (args: readonly string[], description: string) => assertCommandSucceeded(
        await exec.run(executable, args, { timeoutMs: commandTimeoutMs }),
        description,
    );

    const runSearch = async (args: readonly string[]) => {
        const result = await exec.run(executable, args, { timeoutMs: commandTimeoutMs });
        if (result.exitCode === 0) {
            return result;
        }
        // WinApp v0.6.0 returns exit 1 for a valid JSON search with zero
        // matches. Preserve that result so polling and lookup can return [].
        if (result.exitCode === 1) {
            try {
                parseWinappSearchPayload(result.stdout);
                return result;
            } catch {
                // Fall through to the normal typed command error.
            }
        }
        return assertCommandSucceeded(result, 'ui search');
    };

    const rememberElementWindow = (element: IUiElementRef, windowHandle: string) => {
        elementWindowHandles.set(element, windowHandle);
    };

    const targetArgsForWindow = (windowRef: IUiElementRef) => {
        if (/^\d+$/u.test(windowRef.handle)) {
            return [
                '--window',
                windowRef.handle,
            ];
        }
        if (windowRef.processId !== null) {
            return [
                '--app',
                String(windowRef.processId),
            ];
        }
        throw new UnsupportedWinappOperationError(
            'target a window',
            'the reference has no numeric HWND or process ID',
        );
    };

    const targetArgsForElement = (element: IUiElementRef) => {
        const windowHandle = elementWindowHandles.get(element);
        if (windowHandle !== undefined) {
            return [
                '--window',
                windowHandle,
            ];
        }
        if (element.controlType === 'Window' && /^\d+$/u.test(element.handle)) {
            return [
                '--window',
                element.handle,
            ];
        }
        if (element.processId !== null) {
            return [
                '--app',
                String(element.processId),
            ];
        }
        throw new UnsupportedWinappOperationError(
            'target element ' + element.handle,
            'the reference was not returned by this adapter and has no process ID',
        );
    };

    const toWindowRef = (window: IWinappWindowPayload, automationId: string | null = null) => ({
        handle: String(window.hwnd),
        controlType: 'Window',
        name: window.title ?? window.label ?? '',
        automationId,
        processId: window.processId,
    } satisfies IUiElementRef);

    const findControl = async (windowRef: IUiElementRef, selector: IUiSelector) => {
        lastWindowRef = windowRef;
        const windowArgs = targetArgsForWindow(windowRef);
        if (selector.processId !== undefined
            && windowRef.processId !== null
            && selector.processId !== windowRef.processId) {
            return [];
        }

        const names = selectorNameCandidates(selector);
        const queries = selector.automationId !== undefined
            ? [selector.automationId]
            : names;
        const found: IUiElementRef[] = [];

        if (queries.length > 0) {
            for (const query of queries) {
                const result = await runSearch([
                    ...winappCommands.search,
                    query,
                    '--json',
                    '--max',
                    String(WINAPP_SEARCH_MAX_RESULTS),
                    ...windowArgs,
                ]);
                const payload_ = requireCompleteSearch(
                    parseWinappSearchPayload(result.stdout),
                    'find a control',
                );
                for (const payload of payload_.matches) {
                    if (!matchesSelectorPayload(payload, selector, windowRef.processId)) {
                        continue;
                    }
                    if (payload.selector === undefined || payload.selector === null || payload.selector.length === 0) {
                        throw new UnsupportedWinappOperationError(
                            'find a control',
                            'ui search returned a matching element without a semantic selector',
                        );
                    }
                    const element = toActionableUiElementRef(payload, windowRef.processId);
                    if (matchesSelector(element, selector)) {
                        rememberElementWindow(element, windowRef.handle);
                        found.push(element);
                    }
                }
            }
            return uniqueElements(found);
        }

        const result = await run([
            ...winappCommands.inspect,
            '--depth',
            String(WINAPP_INSPECT_DEPTH),
            '--json',
            ...windowArgs,
        ], 'ui inspect');
        for (const match of parseInspectElements(parseWinappInspectPayload(result.stdout), windowRef.processId)) {
            if (matchesSelector(match.element, selector)) {
                rememberElementWindow(match.element, match.windowHandle);
                found.push(match.element);
            }
        }
        return uniqueElements(found);
    };

    const adapter: INativeUiAdapter = {
        driver: 'winapp',
        actionLog,
        findWindow: async (query: IUiWindowQuery) => {
            screenshotWindowRef = null;
            const args: string[] = [...winappCommands.listWindows];
            if (query.processId !== undefined) {
                args.push('--app', String(query.processId));
            }
            args.push('--json');
            const windows = parseWinappWindows((await run(args, 'ui list-windows')).stdout);
            const matches = windows.filter(window => {
                const title = window.title ?? '';
                return (query.titleContains === undefined
                    || title.toLocaleLowerCase().includes(query.titleContains.toLocaleLowerCase()))
                    && (query.className === undefined || window.className === query.className)
                    && (query.processId === undefined || window.processId === query.processId);
            });
            if (query.automationId === undefined) {
                const window = matches[0];
                if (window === undefined) {
                    return null;
                }
                const ref = toWindowRef(window);
                lastWindowRef = ref;
                screenshotWindowRef = ref;
                return ref;
            }

            // list-windows has no automationId field. Inspect only candidate
            // windows, then expose the queried automation id on the window ref.
            for (const window of matches) {
                const result = await run([
                    ...winappCommands.inspect,
                    '--depth',
                    '0',
                    '--json',
                    '--window',
                    String(window.hwnd),
                ], 'ui inspect');
                const inspect = parseWinappInspectPayload(result.stdout);
                const hasAutomationId = parseInspectElements(inspect, window.processId)
                    .some(match => match.element.automationId === query.automationId);
                if (hasAutomationId) {
                    const ref = toWindowRef(window, query.automationId);
                    lastWindowRef = ref;
                    screenshotWindowRef = ref;
                    return ref;
                }
            }
            return null;
        },
        findControl,
        invoke: async ref => {
            const result = await run([
                ...winappCommands.invoke,
                ref.handle,
                '--json',
                ...targetArgsForElement(ref),
            ], 'ui invoke');
            parseWinappInvokePayload(result.stdout);
            actionLog.record({
                actionKind: 'pattern',
                action: 'invoke',
                target: ref.handle,
            });
        },
        setValue: async (ref, text) => {
            const result = await run([
                ...winappCommands.setValue,
                ref.handle,
                text,
                '--json',
                ...targetArgsForElement(ref),
            ], 'ui set-value');
            parseWinappSetValuePayload(result.stdout);
            actionLog.record({
                actionKind: 'pattern',
                action: 'set-value',
                target: ref.handle,
            });
        },
        select: async (ref, item) => {
            if (item.length === 0) {
                throw new UnsupportedWinappOperationError('select', 'the item name is empty');
            }
            const windowArgs = targetArgsForElement(ref);
            const searchResult = await runSearch([
                ...winappCommands.search,
                item,
                '--json',
                '--max',
                String(WINAPP_SEARCH_MAX_RESULTS),
                ...windowArgs,
            ]);
            const candidates = requireCompleteSearch(
                parseWinappSearchPayload(searchResult.stdout),
                'select an item',
            ).matches
                .filter(payload => payload.type === 'ListItem' && payload.name === item)
                .map(payload => {
                    if (payload.selector === undefined || payload.selector === null || payload.selector.length === 0) {
                        throw new UnsupportedWinappOperationError(
                            'select an item',
                            'ui search returned a matching list item without a semantic selector',
                        );
                    }
                    return toActionableUiElementRef(payload, ref.processId);
                });
            if (candidates.length === 0) {
                throw new UnsupportedWinappOperationError(
                    'select',
                    'the list item ' + JSON.stringify(item) + ' was not found by ui search',
                );
            }
            if (candidates.length > 1) {
                throw new UnsupportedWinappOperationError(
                    'select',
                    'ui search returned multiple list items named ' + JSON.stringify(item),
                );
            }
            const [candidate] = candidates;
            if (candidate === undefined) {
                throw new UnsupportedWinappOperationError('select', 'the matching list item disappeared');
            }
            if (windowArgs[0] === '--window' && windowArgs[1] !== undefined) {
                rememberElementWindow(candidate, windowArgs[1]);
            }
            const invokeResult = await run([
                ...winappCommands.invoke,
                candidate.handle,
                '--json',
                ...windowArgs,
            ], 'ui invoke');
            parseWinappInvokePayload(invokeResult.stdout);
            actionLog.record({
                actionKind: 'pattern',
                action: 'select',
                target: ref.handle,
            });
        },
        sendKeys: async (windowRef, keys) => {
            const translatedKeys = translateLegacySendKeys(keys);
            const result = await run([
                ...winappCommands.sendKeys,
                translatedKeys,
                '--json',
                '--via',
                'post-message',
                ...targetArgsForWindow(windowRef),
            ], 'ui send-keys');
            parseWinappSendKeysPayload(result.stdout);
            actionLog.record({
                actionKind: 'input',
                action: 'send-keys',
                target: windowRef.handle,
            });
        },
        waitFor: async (selector, timeoutMs) => {
            if (lastWindowRef === null) {
                throw new UnsupportedWinappOperationError(
                    'wait for a control',
                    'no window has been discovered yet',
                );
            }
            return waitForUniqueControl({
                adapter,
                windowRef: lastWindowRef,
                selector,
                timeoutMs,
                sleep: clock.sleep,
                now: clock.now,
            });
        },
        captureTree: async windowRef => {
            lastWindowRef = windowRef;
            screenshotWindowRef = windowRef;
            const result = await run([
                ...winappCommands.inspect,
                '--depth',
                String(WINAPP_INSPECT_DEPTH),
                '--json',
                ...targetArgsForWindow(windowRef),
            ], 'ui inspect');
            return parseWinappInspectPayload(result.stdout);
        },
        screenshot: async filePath => {
            if (screenshotWindowRef === null) {
                throw new UnsupportedWinappOperationError(
                    'capture a screenshot',
                    'no explicit window target has been discovered yet',
                );
            }
            const targetWindowRef = screenshotWindowRef;
            const result = await run([
                ...winappCommands.screenshot,
                '--json',
                '--output',
                filePath,
                ...targetArgsForWindow(targetWindowRef),
            ], 'ui screenshot');
            const screenshot = parseWinappScreenshotPayload(result.stdout);
            if (/^\d+$/u.test(targetWindowRef.handle)
                && screenshot.hwnd !== Number(targetWindowRef.handle)) {
                throw new Error(
                    'winapp CLI ui screenshot returned HWND '
                    + screenshot.hwnd
                    + ' for requested HWND '
                    + targetWindowRef.handle,
                );
            }
            actionLog.record({
                actionKind: 'pattern',
                action: 'screenshot',
                target: filePath,
            });
        },
    };
    return adapter;
}

export async function readWinappCliVersion(exec: IGuestCommandRunner, executable = WINAPP_DEFAULT_EXECUTABLE) {
    const result = await exec.run(executable, winappCommands.version, { timeoutMs: 30_000 });
    assertCommandSucceeded(result, '--version');
    return parseWinappVersion(result.stdout);
}

export async function assertPinnedWinappCliVersion(exec: IGuestCommandRunner, executable = WINAPP_DEFAULT_EXECUTABLE) {
    const version = await readWinappCliVersion(exec, executable);
    if (version !== WINAPP_EXPECTED_VERSION) {
        throw new Error(
            'winapp CLI '
            + version
            + ' is installed; the lane pins '
            + WINAPP_EXPECTED_VERSION,
        );
    }
    return version;
}
