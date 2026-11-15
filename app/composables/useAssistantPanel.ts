import type {
    InjectionKey,
    Ref,
} from 'vue';

interface IAssistantPanelInputs {
    /** Turned on for this runtime and not hidden by zen mode. */
    isEnabled: Readonly<Ref<boolean>>;
    hasActiveDocument: Readonly<Ref<boolean>>;
}

const assistantPanelInputsKey: InjectionKey<IAssistantPanelInputs> = Symbol('assistant-panel-inputs');

/** The shell passes its live inputs; its toolbar descendants inject the same ones. */
export const useAssistantPanel = (inputs?: IAssistantPanelInputs) => {
    if (inputs) {
        provide(assistantPanelInputsKey, inputs);
    }
    const panelInputs = inputs ?? inject(assistantPanelInputsKey, null);
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
};
