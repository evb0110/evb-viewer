import { vi } from 'vitest';
import { cast } from '@tests/helpers/cast';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceAutomationStateSnapshot,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';

export function createWorkspaceAutomationStateSnapshot(
    overrides: Partial<IWorkspaceAutomationStateSnapshot> = {},
): IWorkspaceAutomationStateSnapshot {
    return {
        documentIdentity: null,
        annotationComments: [],
        annotationCommentsStatus: 'ready',
        annotationInventory: null,
        annotationDirty: false,
        originalPath: null,
        sortedAnnotationNoteWindows: [],
        workingCopyPath: null,
        ...overrides,
    };
}

const COMMAND_NAME_PATTERN = /^(?:handle|set|pageOps|capture|restore|wait|run|read|create|comment|highlight|scroll|getAll|getDeleted|close)/u;

/** A workspace command surface whose every command is a spy resolving to true. */
export function createWorkspaceExposeFixture(
    overrides: Partial<IWorkspaceExpose> = {},
    hasPdf: IWorkspaceExpose['hasPdf'] = true,
): IWorkspaceExpose {
    const surface: Record<string, unknown> = {
        hasPdf,
        getToolbarSnapshot: () => createDefaultWorkspaceToolbarSnapshot(),
        getOpenFailure: () => null,
        getAutomationStateSnapshot: () => createWorkspaceAutomationStateSnapshot(),
        ...overrides,
    };
    return cast<IWorkspaceExpose>(new Proxy(surface, {get(target, key) {
        if (typeof key === 'string' && !(key in target) && COMMAND_NAME_PATTERN.test(key)) {
            target[key] = vi.fn(async () => true);
        }
        return target[key as string];
    }}));
}

export interface IKeyboardEventFixtureOptions {
    key: string;
    code?: string;
    target?: EventTarget | IKeyboardEventTargetFixture | null;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
    stopImmediatePropagation?: () => void;
}

export interface IKeyboardEventTargetFixture {
    closest?: (selector: string) => unknown;
    isContentEditable?: boolean;
    nodeName?: string;
}

export function createKeyboardEventFixture(options: IKeyboardEventFixtureOptions): KeyboardEvent {
    // The node test environment has no DOM KeyboardEvent constructor. These
    // listeners only read the fields below, so keep the boundary fixture small.
    const event = {
        type: 'keydown',
        key: options.key,
        code: options.code ?? options.key,
        target: options.target ?? null,
        metaKey: options.metaKey ?? false,
        ctrlKey: options.ctrlKey ?? false,
        altKey: options.altKey ?? false,
        shiftKey: options.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
        preventDefault: options.preventDefault ?? (() => undefined),
        stopPropagation: options.stopPropagation ?? (() => undefined),
        stopImmediatePropagation: options.stopImmediatePropagation ?? (() => undefined),
    } as KeyboardEvent;

    return event;
}
