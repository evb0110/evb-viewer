import type {
    InjectionKey,
    Ref,
} from 'vue';

export interface IAssistantPanelInputs {
    /** Turned on for this runtime and not hidden by zen mode. */
    isEnabled: Readonly<Ref<boolean>>;
    hasActiveDocument: Readonly<Ref<boolean>>;
}

const assistantPanelInputsKey: InjectionKey<IAssistantPanelInputs> = Symbol('assistant-panel-inputs');

function createAssistantPanelBindings(panelInputs: IAssistantPanelInputs | null) {
    const isOpen = useState('assistant-panel:open', () => false);
    const isEnabled = computed(() => panelInputs?.isEnabled.value === true);
    const isAvailable = computed(() => isEnabled.value && panelInputs?.hasActiveDocument.value === true);

    const open = () => {
        if (isAvailable.value) {
            isOpen.value = true;
        }
    };

    const close = () => {
        isOpen.value = false;
    };

    const toggle = () => {
        if (isOpen.value) {
            close();
        } else {
            open();
        }
    };

    return {
        isOpen,
        isEnabled,
        isAvailable,
        open,
        close,
        toggle,
    };
}

/** Called by the workspace shell to provide its live assistant inputs to descendants. */
export const provideAssistantPanel = (inputs: IAssistantPanelInputs) => {
    provide(assistantPanelInputsKey, inputs);
    return createAssistantPanelBindings(inputs);
};

/** Reads the shell's assistant panel state, remaining safely disabled without a provider. */
export const useAssistantPanel = () => {
    return createAssistantPanelBindings(inject(assistantPanelInputsKey, null));
};
