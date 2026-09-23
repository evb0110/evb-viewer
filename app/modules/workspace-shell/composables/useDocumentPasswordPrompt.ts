type TPasswordPromptResult = string | null;
type TPasswordRequest = Promise<TPasswordPromptResult>;

const open = ref(false);
const checking = ref(false);
const fileName = ref('');
const errorMessage = ref<string | null>(null);
let activePrompt: {
    owner: symbol;
    request: TPasswordRequest;
    // Null once a password is submitted and the open flow is checking it.
    resolve: ((password: TPasswordPromptResult) => void) | null;
} | null = null;

function resolvePasswordPrompt(result: TPasswordPromptResult, owner?: symbol) {
    if (owner !== undefined && activePrompt?.owner !== owner) {
        return;
    }
    const resolver = activePrompt?.resolve;
    activePrompt = null;
    open.value = false;
    checking.value = false;
    fileName.value = '';
    errorMessage.value = null;
    resolver?.(result);
}

/**
 * Provides the one password prompt used by the workspace open flow. The
 * resolver is module-scoped because the shell owns the modal while individual
 * document sessions own the open requests.
 *
 * A submitted password leaves the prompt open in a checking state until the
 * open flow either asks again or calls `closePasswordPrompt`, so a wrong
 * password does not close and reopen the dialog.
 */
export const useDocumentPasswordPrompt = () => {
    const owner = Symbol('document-password-prompt');

    function requestPassword(
        nextFileName: string,
        nextErrorMessage: string | null = null,
    ): TPasswordRequest {
        activePrompt?.resolve?.(null);
        fileName.value = nextFileName;
        errorMessage.value = nextErrorMessage;
        checking.value = false;
        open.value = true;
        let resolve!: (password: TPasswordPromptResult) => void;
        const request = new Promise<TPasswordPromptResult>((resolveRequest) => {
            resolve = resolveRequest;
        });
        activePrompt = {
            owner,
            request,
            resolve,
        };
        return request;
    }

    function submitPassword(password: string) {
        const resolver = activePrompt?.resolve;
        if (!activePrompt || !resolver) {
            return;
        }
        activePrompt.resolve = null;
        checking.value = true;
        resolver(password);
    }

    function cancelPasswordPrompt() {
        resolvePasswordPrompt(null);
    }

    /** Closes the prompt shown for `request` once the open flow no longer needs it. */
    function closePasswordPrompt(request: TPasswordRequest) {
        if (activePrompt?.request === request) {
            resolvePasswordPrompt(null);
        }
    }

    if (getCurrentScope()) {
        onScopeDispose(() => resolvePasswordPrompt(null, owner));
    }

    return {
        open: computed(() => open.value),
        checking: computed(() => checking.value),
        fileName: computed(() => fileName.value),
        errorMessage: computed(() => errorMessage.value),
        requestPassword,
        submitPassword,
        cancelPasswordPrompt,
        closePasswordPrompt,
    };
};
