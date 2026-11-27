import type {TDocumentRef} from '@contracts/documentRef';

type TDirectOpenDelegate = (path: TDocumentRef) => Promise<boolean>;

interface IDirectOpenDelegateEntry {
    delegate: TDirectOpenDelegate;
    id: symbol;
}

const delegates: IDirectOpenDelegateEntry[] = [];
let shellInstallCount = 0;

async function dispatchDirectOpen(path: TDocumentRef) {
    const delegate = delegates.at(-1)?.delegate ?? null;
    if (!delegate) {
        return false;
    }

    return delegate(path);
}

function getDispatcherWindow() {
    return typeof window === 'undefined' ? null : window;
}

function installDirectOpenAutomationDispatcher() {
    const dispatcherWindow = getDispatcherWindow();
    if (!dispatcherWindow) {
        return () => {};
    }

    shellInstallCount += 1;
    dispatcherWindow.__openFileDirect = dispatchDirectOpen;

    return () => {
        shellInstallCount = Math.max(0, shellInstallCount - 1);
        if (shellInstallCount === 0 && dispatcherWindow.__openFileDirect === dispatchDirectOpen) {
            delete dispatcherWindow.__openFileDirect;
        }
    };
}

export function registerDirectOpenAutomationDelegate(delegate: TDirectOpenDelegate) {
    const dispatcherWindow = getDispatcherWindow();
    const entry: IDirectOpenDelegateEntry = {
        delegate,
        id: Symbol('direct-open-delegate'),
    };

    delegates.push(entry);
    if (dispatcherWindow && dispatcherWindow.__openFileDirect !== dispatchDirectOpen) {
        dispatcherWindow.__openFileDirect = dispatchDirectOpen;
    }

    return () => {
        const index = delegates.findIndex((candidate) => candidate.id === entry.id);
        if (index >= 0) {
            delegates.splice(index, 1);
        }
    };
}

export const useDirectOpenAutomationDispatcherShell = () => {
    let cleanup: (() => void) | null = null;

    onMounted(() => {
        cleanup = installDirectOpenAutomationDispatcher();
    });

    onUnmounted(() => {
        cleanup?.();
        cleanup = null;
    });
};
