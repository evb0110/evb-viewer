import {AsyncLocalStorage} from 'node:async_hooks';

interface IWorkingCopyMutationCommitSignal {
    markCommitStarted: () => void;
}

const activeWorkingCopyMutationCommitSignal = new AsyncLocalStorage<IWorkingCopyMutationCommitSignal>();

export function runWithWorkingCopyMutationCommitSignal<T>(signal: IWorkingCopyMutationCommitSignal, callback: () => T) {
    return activeWorkingCopyMutationCommitSignal.run(signal, callback);
}

export function markActiveWorkingCopyMutationCommitStarted() {
    activeWorkingCopyMutationCommitSignal.getStore()?.markCommitStarted();
}
