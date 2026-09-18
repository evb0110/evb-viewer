export const nativeUiDrivers = [
    'winapp',
    'uia3',
] as const;

export type TNativeUiDriver = typeof nativeUiDrivers[number];

export const nativeUiActionKinds = [
    'pattern',
    'input',
] as const;

export type TNativeUiActionKind = typeof nativeUiActionKinds[number];

export interface IUiElementRef {
    handle: string;
    controlType: string;
    name: string;
    automationId: string | null;
    processId: number | null;
}

export interface IUiSelectorName {
    exact?: string;
    localizedFallbacks?: string[];
}

export interface IUiSelector {
    automationId?: string;
    controlType: string;
    name?: IUiSelectorName;
    processId?: number;
    index?: number;
}

export interface IUiWindowQuery {
    titleContains?: string;
    automationId?: string;
    className?: string;
    processId?: number;
}

export interface INativeUiActionRecord {
    actionKind: TNativeUiActionKind;
    action: string;
    target: string;
}

export interface INativeUiActionLog {
    subscribe?(listener: (entry: INativeUiActionRecord) => void): () => void;
    record(entry: INativeUiActionRecord): void;
    entries(): INativeUiActionRecord[];
}

export function createNativeUiActionLog(): INativeUiActionLog {
    const entries: INativeUiActionRecord[] = [];
    const listeners = new Set<(entry: INativeUiActionRecord) => void>();
    return {
        record: entry => {
            entries.push(entry);
            for (const listener of listeners) { listener(entry); }
        },
        entries: () => [...entries],
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

export interface INativeUiAdapter {
    driver: TNativeUiDriver;
    actionLog: INativeUiActionLog;
    findWindow(query: IUiWindowQuery): Promise<IUiElementRef | null>;
    findControl(windowRef: IUiElementRef, selector: IUiSelector): Promise<IUiElementRef[]>;
    invoke(ref: IUiElementRef): Promise<void>;
    setValue(ref: IUiElementRef, text: string): Promise<void>;
    select(ref: IUiElementRef, item: string): Promise<void>;
    sendKeys(windowRef: IUiElementRef, keys: string): Promise<void>;
    waitFor(selector: IUiSelector, timeoutMs: number): Promise<IUiElementRef>;
    captureTree(windowRef: IUiElementRef): Promise<unknown>;
    screenshot(filePath: string): Promise<void>;
}

export class AmbiguousSelectorError extends Error {
    constructor(public readonly selector: IUiSelector, public readonly candidates: readonly IUiElementRef[]) {
        super(
            `Selector ${describeUiSelector(selector)} matched ${candidates.length} elements: `
            + candidates.map(describeUiElement).join(' | '),
        );
        this.name = 'AmbiguousSelectorError';
    }
}

export class SelectorNotFoundError extends Error {
    constructor(public readonly selector: IUiSelector) {
        super(`Selector ${describeUiSelector(selector)} matched no elements`);
        this.name = 'SelectorNotFoundError';
    }
}

export class DesktopUnavailableError extends Error {
    constructor(reason: string) {
        super(`Interactive desktop unavailable: ${reason}`);
        this.name = 'DesktopUnavailableError';
    }
}

export function describeUiSelector(selector: IUiSelector) {
    const parts = [`controlType=${selector.controlType}`];
    if (selector.automationId !== undefined) {
        parts.push(`automationId=${selector.automationId}`);
    }
    if (selector.name?.exact !== undefined) {
        parts.push(`name=${selector.name.exact}`);
    }
    if (selector.processId !== undefined) {
        parts.push(`processId=${selector.processId}`);
    }
    if (selector.index !== undefined) {
        parts.push(`index=${selector.index}`);
    }
    return `{${parts.join(', ')}}`;
}

export function describeUiElement(element: IUiElementRef) {
    return `${element.controlType}#${element.automationId ?? '-'}("${element.name}")@${element.handle}`;
}

export function selectorNameCandidates(selector: IUiSelector) {
    const names: string[] = [];
    if (selector.name?.exact !== undefined) {
        names.push(selector.name.exact);
    }
    names.push(...selector.name?.localizedFallbacks ?? []);
    return names;
}

export function resolveUniqueElement(candidates: readonly IUiElementRef[], selector: IUiSelector) {
    if (selector.index !== undefined) {
        const chosen = candidates[selector.index];
        if (chosen === undefined) {
            throw new SelectorNotFoundError(selector);
        }
        return chosen;
    }
    if (candidates.length === 0) {
        throw new SelectorNotFoundError(selector);
    }
    if (candidates.length > 1) {
        throw new AmbiguousSelectorError(selector, candidates);
    }
    const [only] = candidates;
    if (only === undefined) {
        throw new SelectorNotFoundError(selector);
    }
    return only;
}

export async function resolveUniqueControl(
    adapter: INativeUiAdapter,
    windowRef: IUiElementRef,
    selector: IUiSelector,
) {
    return resolveUniqueElement(await adapter.findControl(windowRef, selector), selector);
}

export interface IWaitForControlOptions {
    adapter: INativeUiAdapter;
    windowRef: IUiElementRef;
    selector: IUiSelector;
    timeoutMs: number;
    pollIntervalMs?: number;
    sleep(milliseconds: number): Promise<void>;
    now(): number;
}

export async function waitForUniqueControl({
    adapter,
    windowRef,
    selector,
    timeoutMs,
    pollIntervalMs = 250,
    sleep,
    now,
}: IWaitForControlOptions) {
    const deadline = now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
        try {
            return await resolveUniqueControl(adapter, windowRef, selector);
        } catch (error) {
            if (error instanceof AmbiguousSelectorError || error instanceof DesktopUnavailableError) {
                throw error;
            }
            lastError = error;
        }
        if (now() >= deadline) {
            throw lastError instanceof Error
                ? lastError
                : new SelectorNotFoundError(selector);
        }
        await sleep(pollIntervalMs);
    }
}
