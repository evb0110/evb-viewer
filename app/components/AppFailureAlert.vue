<template>
    <UAlert
        color="error"
        :variant="variant"
        :icon="icon"
        :title="presentation.title"
        :description="formatFailurePresentationDescription(presentation)"
        :actions="actions"
    >
        <template v-if="presentation.technicalDetails" #description>
            <div class="flex flex-col gap-2">
                <p>{{ presentation.description }}</p>
                <details class="text-sm">
                    <summary class="cursor-pointer font-medium">{{ t('errors.runtime.details') }}</summary>
                    <pre class="app-scrollbar app-scroll-region--balanced mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ technicalDetails }}</pre>
                </details>
            </div>
        </template>
    </UAlert>
</template>

<script setup lang="ts">
import type {FailurePresentation} from '@app/composables/useFailureToast';
import {
    copyFailurePresentation,
    formatFailurePresentationDescription,
    getNonEmptyDetails,
} from '@app/composables/useFailureToast';

const {
    presentation,
    icon = 'i-ph-warning',
    variant = 'soft',
} = defineProps<{
    presentation: FailurePresentation;
    icon?: string;
    variant?: 'soft' | 'subtle' | 'outline' | 'solid'
}>();

const { t } = useTypedI18n();

const technicalDetails = computed(() => getNonEmptyDetails([
    presentation.technicalDetails,
    `Error ID: ${presentation.failure.eventId}`,
]));

const actions = computed(() => [
    {
        label: t('errors.runtime.copy'),
        onClick: () => {
            void copyFailurePresentation(presentation);
        },
    },
    ...(presentation.actions ?? []),
]);
</script>
