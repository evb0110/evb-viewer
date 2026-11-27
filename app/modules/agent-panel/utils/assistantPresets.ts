import type {TAgentAssistantPresetId} from '@contracts/agent';

export interface IAssistantPreset {
    id: TAgentAssistantPresetId;
    icon: string;
}

// One-click document actions surfaced in the empty assistant chat. Each id maps to an
// edge-case-aware workflow injected server-side; labels are resolved with t() in the panel.
export const ASSISTANT_PRESETS: readonly IAssistantPreset[] = [
    {
        id: 'add-bookmarks',
        icon: 'i-ph-bookmark',
    },
    {
        id: 'number-pages',
        icon: 'i-ph-hash',
    },
    {
        id: 'check-ocr-readiness',
        icon: 'i-ph-text-aa',
    },
];
