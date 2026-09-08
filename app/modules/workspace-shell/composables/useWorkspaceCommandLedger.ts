import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';
import type {IWorkspaceCommandRegistration} from '@app/types/workspaceCommand';

interface IWorkspaceCommand {
    readonly source: TWorkspaceUndoSource;
    readonly entityIds: ReadonlySet<string> | null;
    readonly checkpoint: number;
    readonly inverse: 'undo';
    readonly estimatedBytes: number;
    readonly onDiscard: (() => void) | undefined;
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): Promise<boolean>;
    cmd(): Promise<boolean>;
}

const MAX_WORKSPACE_COMMAND_DEPTH = 128;
const MAX_WORKSPACE_COMMAND_BYTES = 32 * 1024 * 1024;
const DEFAULT_WORKSPACE_COMMAND_BYTES = 1024;

export const useWorkspaceCommandLedger = () => {
    // This is the single workspace command stack. File checkpoints, metadata
    // inverse commands and annotation commands are represented identically;
    // the source is diagnostic metadata, not a routing authority.
    const commands = shallowRef<IWorkspaceCommand[]>([]);
    const commandIndex = ref(-1);
    let isExecutingCommand = false;

    function createCommand(input: IWorkspaceCommandRegistration): IWorkspaceCommand {
        return {
            source: input.source,
            entityIds: input.entityIds ? new Set(input.entityIds) : null,
            checkpoint: commands.value.length,
            inverse: 'undo',
            estimatedBytes: Math.max(0, input.estimatedBytes ?? DEFAULT_WORKSPACE_COMMAND_BYTES),
            onDiscard: input.onDiscard,
            canUndo: input.canUndo ?? (() => true),
            canRedo: input.canRedo ?? (() => true),
            undo: async () => (await input.undo()) === true,
            cmd: async () => (await input.cmd()) === true,
        };
    }

    function recordEntry(command: IWorkspaceCommand) {
        if (isExecutingCommand) {
            command.onDiscard?.();
            return;
        }
        const discarded = commands.value.slice(commandIndex.value + 1);
        const nextCommands = commands.value.slice(0, commandIndex.value + 1);
        nextCommands.push(command);
        let retainedBytes = nextCommands.reduce((total, entry) => total + entry.estimatedBytes, 0);
        while (
            nextCommands.length > 1
            && (nextCommands.length > MAX_WORKSPACE_COMMAND_DEPTH || retainedBytes > MAX_WORKSPACE_COMMAND_BYTES)
        ) {
            const removed = nextCommands.shift();
            retainedBytes -= removed?.estimatedBytes ?? 0;
            if (removed) discarded.push(removed);
        }
        commands.value = nextCommands;
        commandIndex.value = commands.value.length - 1;
        discarded.forEach(entry => entry.onDiscard?.());
    }

    function registerCommand(input: IWorkspaceCommandRegistration) {
        recordEntry(createCommand(input));
    }

    function pruneEntries(shouldRemove: (command: IWorkspaceCommand) => boolean) {
        if (commands.value.length === 0) {
            return;
        }

        let removedAppliedCommands = 0;
        const discarded: IWorkspaceCommand[] = [];
        const nextCommands = commands.value.filter((command, index) => {
            const removed = shouldRemove(command);
            if (removed) discarded.push(command);
            if (removed && index <= commandIndex.value) {
                removedAppliedCommands += 1;
            }
            return !removed;
        });

        commands.value = nextCommands;
        discarded.forEach(command => command.onDiscard?.());
        if (nextCommands.length === 0) {
            commandIndex.value = -1;
            return;
        }

        commandIndex.value = Math.min(
            nextCommands.length - 1,
            Math.max(-1, commandIndex.value - removedAppliedCommands),
        );
    }

    function resetTimeline() {
        const discarded = commands.value;
        commands.value = [];
        commandIndex.value = -1;
        discarded.forEach(command => command.onDiscard?.());
    }

    function resetSource(source?: TWorkspaceUndoSource) {
        if (source === undefined) {
            resetTimeline();
            return;
        }
        pruneEntries(command => command.source === source);
    }

    function ownsAnyEntity(command: IWorkspaceCommand, entityIds: ReadonlySet<string>) {
        if (!command.entityIds) {
            return false;
        }
        for (const id of command.entityIds) {
            if (entityIds.has(id)) {
                return true;
            }
        }
        return false;
    }

    // A producer that hard-removes an entity keeps the rest of its timeline: only
    // the commands replaying a removed entity lose their meaning. Commands that
    // name no entity are unowned and stay.
    function forgetSourceEntries(source: TWorkspaceUndoSource, entityIds: ReadonlySet<string>) {
        if (entityIds.size === 0) {
            return;
        }
        pruneEntries(command => command.source === source && ownsAnyEntity(command, entityIds));
    }

    const canUndoTimeline = computed(() => (
        commands.value[commandIndex.value]?.canUndo() === true
    ));
    const canRedoTimeline = computed(
        () => commands.value[commandIndex.value + 1]?.canRedo() === true,
    );
    const nextUndoSource = computed<TWorkspaceUndoSource | null>(
        () => commands.value[commandIndex.value]?.source ?? null,
    );
    const nextRedoSource = computed<TWorkspaceUndoSource | null>(
        () => commands.value[commandIndex.value + 1]?.source ?? null,
    );

    // Inverses may be asynchronous, and pruning is not gated on them: the reset
    // and forget calls come from lifecycle callbacks (document reopen, viewer
    // swap, hard shape removal) that no busy flag holds back. So a settling
    // command must never move the cursor by the position it read before its
    // await. It settles against its own entry instead: pruning has already
    // rebased the cursor around everything it removed, so re-deriving the
    // cursor from the entry's current position is the only step that cannot
    // skip, replay or resurrect a survivor. An entry that no longer exists
    // settles into nothing.
    function positionOf(command: IWorkspaceCommand) {
        return commands.value.indexOf(command);
    }

    // A command whose inverse reports no work is stale, so it leaves the
    // timeline and the cursor lands on the entry below the one it occupied.
    function retireCommandAt(position: number) {
        const nextCommands = commands.value.slice();
        const [discarded] = nextCommands.splice(position, 1);
        commands.value = nextCommands;
        commandIndex.value = Math.min(position - 1, nextCommands.length - 1);
        discarded?.onDiscard?.();
    }

    async function undoTimeline() {
        const command = commands.value[commandIndex.value];
        if (!command || !command.canUndo() || isExecutingCommand) {
            return false;
        }
        isExecutingCommand = true;
        try {
            const didUndo = await command.undo();
            const position = positionOf(command);
            if (position < 0) {
                return didUndo;
            }
            if (!didUndo) {
                retireCommandAt(position);
                return false;
            }
            commandIndex.value = position - 1;
            return true;
        } finally {
            isExecutingCommand = false;
        }
    }

    async function redoTimeline() {
        const command = commands.value[commandIndex.value + 1];
        if (!command || !command.canRedo() || isExecutingCommand) {
            return false;
        }
        isExecutingCommand = true;
        try {
            const didRedo = await command.cmd();
            const position = positionOf(command);
            if (position < 0) {
                return didRedo;
            }
            if (!didRedo) {
                retireCommandAt(position);
                return false;
            }
            commandIndex.value = position;
            return true;
        } finally {
            isExecutingCommand = false;
        }
    }

    return {
        canUndoTimeline,
        canRedoTimeline,
        nextUndoSource,
        nextRedoSource,
        registerCommand,
        forgetSourceEntries,
        resetSource,
        resetTimeline,
        undoTimeline,
        redoTimeline,
    };
};
