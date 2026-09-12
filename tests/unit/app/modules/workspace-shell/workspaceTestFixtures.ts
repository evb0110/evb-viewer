import { vi } from 'vitest';
import {
    createWorkspaceExposeCommandHandlers,
    createWorkspaceExposeFromCommandHandlers,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
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

export function createWorkspaceExposeFixture(
    overrides: Partial<IWorkspaceExpose> = {},
    hasPdf: IWorkspaceExpose['hasPdf'] = true,
): IWorkspaceExpose {
    const handlers = createWorkspaceExposeCommandHandlers(descriptor => (
        descriptor.kind === 'async'
            ? vi.fn(async () => true)
            : vi.fn()
    ));

    return createWorkspaceExposeFromCommandHandlers(hasPdf, handlers, {
        getToolbarSnapshot: () => createDefaultWorkspaceToolbarSnapshot(),
        getAutomationStateSnapshot: () => createWorkspaceAutomationStateSnapshot(),
        ...overrides,
    });
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
