type TPasswordPromptResult = string | null;

const open = ref(false);
const fileName = ref('');
const errorMessage = ref<string | null>(null);
let activePrompt: {
    owner: symbol;
    resolve: (password: TPasswordPromptResult) => void;
} | null = null;

function resolvePasswordPrompt(result: TPasswordPromptResult, owner?: symbol) {
    if (owner !== undefined && activePrompt?.owner !== owner) {
        return;
    }
    const resolver = activePrompt?.resolve;
    activePrompt = null;
    open.value = false;
    fileName.value = '';
    errorMessage.value = null;
    resolver?.(result);
}

/**
 * Provides the one password prompt used by the workspace open flow. The
 * resolver is module-scoped because the shell owns the modal while individual
 * document sessions own the open requests.
 */
export const useDocumentPasswordPrompt = () => {
    const owner = Symbol('document-password-prompt');

    function requestPassword(
        nextFileName: string,
        nextErrorMessage: string | null = null,
    ) {
        if (activePrompt) {
            resolvePasswordPrompt(null);
        }
        fileName.value = nextFileName;
        errorMessage.value = nextErrorMessage;
        open.value = true;
        return new Promise<TPasswordPromptResult>((resolve) => {
            activePrompt = {
                owner,
                resolve,
            };
        });
    }

    function submitPassword(password: string) {
        resolvePasswordPrompt(password);
    }

    function cancelPasswordPrompt() {
        resolvePasswordPrompt(null);
    }

    if (getCurrentScope()) {
        onScopeDispose(() => resolvePasswordPrompt(null, owner));
    }

    return {
        open: computed(() => open.value),
        fileName: computed(() => fileName.value),
        errorMessage: computed(() => errorMessage.value),
        requestPassword,
        submitPassword,
        cancelPasswordPrompt,
    };
};
