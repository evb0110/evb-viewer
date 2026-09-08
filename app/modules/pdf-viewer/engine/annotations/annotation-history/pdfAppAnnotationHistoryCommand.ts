import type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export type TRegisterAnnotationHistoryFailureRollback = (rollback: () => void) => void;

export interface IPdfAppAnnotationHistoryCommand {
    /** Register rollback immediately after any partial effect that can precede a throw. */
    cmd: (registerFailureRollback?: TRegisterAnnotationHistoryFailureRollback) => void;
    /** Register rollback immediately after any partial effect that can precede a throw. */
    undo: (registerFailureRollback?: TRegisterAnnotationHistoryFailureRollback) => void;
    /** Includes retained checkpoints/closures; unknown commands use 1 KiB. */
    estimatedBytes?: number;
    /** Called once when the owning timeline releases this command. */
    onDiscard?: (() => void) | undefined;
    /** Canonical entities whose hard removal invalidates this command. */
    annotationIds?: readonly AnnotationId[];
}

export interface IAnnotationHistoryAuthority {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    registerCommand: (command: IPdfAppAnnotationHistoryCommand) => void;
    forgetCommands: (ids: ReadonlySet<AnnotationId>) => void;
    undo: () => boolean;
    redo: () => boolean;
}

export class AnnotationHistoryCompensationError extends Error {
    readonly rollbackErrors: readonly unknown[];

    constructor(originalError: unknown, rollbackErrors: readonly unknown[]) {
        super(`Annotation history rollback failed ${rollbackErrors.length} time(s); history was cleared`, {cause: originalError});
        this.name = 'AnnotationHistoryCompensationError';
        this.rollbackErrors = rollbackErrors;
    }
}

export class AnnotationHistoryIndeterminateError extends Error {
    constructor(originalError: unknown) {
        super('Annotation history command state is indeterminate; history was cleared', {cause: originalError});
        this.name = 'AnnotationHistoryIndeterminateError';
    }
}

export function isAnnotationHistoryPoisoningError(error: unknown) {
    return error instanceof AnnotationHistoryCompensationError
        || error instanceof AnnotationHistoryIndeterminateError;
}

export function buildAnnotationHistoryReplayFailure(
    originalError: unknown,
    rollbacks: ReadonlyArray<() => void>,
) {
    const rollbackErrors: unknown[] = [];
    rollbacks.forEach((rollback) => {
        try {
            rollback();
        } catch (error) {
            rollbackErrors.push(error);
        }
    });
    if (!rollbackErrors.length) {
        return originalError;
    }
    const originalCause = isAnnotationHistoryPoisoningError(originalError)
        ? originalError.cause
        : originalError;
    const priorRollbackErrors = originalError instanceof AnnotationHistoryCompensationError
        ? originalError.rollbackErrors
        : [];
    return new AnnotationHistoryCompensationError(
        originalCause,
        [
            ...priorRollbackErrors,
            ...rollbackErrors,
        ],
    );
}

export class LocalAnnotationHistoryAuthority implements IAnnotationHistoryAuthority {
    readonly #undo: IPdfAppAnnotationHistoryCommand[] = [];
    readonly #redo: IPdfAppAnnotationHistoryCommand[] = [];

    get canUndo() { return this.#undo.length > 0; }
    get canRedo() { return this.#redo.length > 0; }
    registerCommand(command: IPdfAppAnnotationHistoryCommand) {
        this.#undo.push(command);
        this.#redo.splice(0).forEach(discardCommand);
    }
    forgetCommands(ids: ReadonlySet<AnnotationId>) {
        const keep = (command: IPdfAppAnnotationHistoryCommand) => (
            !command.annotationIds?.some(id => ids.has(id))
        );
        const discarded = [
            ...this.#undo,
            ...this.#redo,
        ].filter(command => !keep(command));
        this.#undo.splice(0, this.#undo.length, ...this.#undo.filter(keep));
        this.#redo.splice(0, this.#redo.length, ...this.#redo.filter(keep));
        discarded.forEach(discardCommand);
    }
    undo() {
        const command = this.#undo.at(-1);
        if (!command) {
            return false;
        }
        this.#replay(command.undo);
        this.#undo.pop();
        this.#redo.push(command);
        return true;
    }
    redo() {
        const command = this.#redo.at(-1);
        if (!command) {
            return false;
        }
        this.#replay(command.cmd);
        this.#redo.pop();
        this.#undo.push(command);
        return true;
    }
    #replay(apply: IPdfAppAnnotationHistoryCommand['cmd']) {
        const rollbacks: Array<() => void> = [];
        try {
            apply(rollback => rollbacks.unshift(rollback));
        } catch (error) {
            const failure = buildAnnotationHistoryReplayFailure(error, rollbacks);
            if (isAnnotationHistoryPoisoningError(failure)) {
                [
                    ...this.#undo.splice(0),
                    ...this.#redo.splice(0),
                ].forEach(discardCommand);
            }
            throw failure;
        }
    }
}

function discardCommand(command: IPdfAppAnnotationHistoryCommand) {
    try {
        command.onDiscard?.();
    } catch {
        // Release every retained command and preserve the original replay error.
    }
}
