<template>
    <div class="flex flex-col gap-2">
        <URadioGroup
            v-model="scope"
            :legend="legend"
            :items="items"
            :ui="radioGroupUi"
        />

        <!--
            The range field is always present so choosing "Page range" does not
            push the rest of the dialog down. It sits under the last option, where
            callers put the range, indented to the option labels. Focusing it
            chooses the range, as typing a range in a system print dialog does.
            Callers report an invalid range in their summary line rather than in
            a line of its own that would appear under the field.
        -->
        <UInput
            v-model="rangeInput"
            class="ms-6 self-start"
            :placeholder="placeholder"
            :aria-label="rangeLabel"
            :aria-invalid="invalid || undefined"
            :aria-describedby="describedBy"
            :color="invalid ? 'error' : 'primary'"
            :highlight="invalid"
            @focus="scope = 'range'"
            @blur="emit('rangeBlur')"
        />
    </div>
</template>

<script setup lang="ts">
import type { TPdfPageScope } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfPageScopeSelection';

const scope = defineModel<TPdfPageScope>('scope', { required: true });
const rangeInput = defineModel<string>('rangeInput', { required: true });

const {
    describedBy = undefined,
    invalid = false,
} = defineProps<{
    legend: string;
    items: Array<{
        value: TPdfPageScope;
        label: string;
    }>;
    rangeLabel: string;
    placeholder: string;
    invalid?: boolean;
    describedBy?: string | undefined;
}>();

const emit = defineEmits<{ rangeBlur: [] }>();

const radioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'mb-0.5 text-xs text-muted font-normal',
    item: 'items-center',
    label: 'font-normal',
} as const;
</script>
