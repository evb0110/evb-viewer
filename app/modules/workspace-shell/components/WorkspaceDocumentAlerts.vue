<template>
    <div v-show="visible" class="workspace-document-alerts-root">
        <AppFailureAlert
            v-if="pdfFailurePresentation"
            :presentation="pdfFailurePresentation"
            variant="soft"
            class="mx-3 mt-2"
            data-testid="workspace-document-pdf-error"
        />
        <UAlert
            v-else-if="pdfError"
            color="neutral"
            variant="soft"
            class="mx-3 mt-2"
            data-testid="workspace-document-pdf-error"
            :title="t('errors.file.open')"
            :description="String(pdfError)"
            :ui="{ title: 'sr-only' }"
        />

        <AppFailureAlert
            v-if="showDjvuConversionUi && djvuFailurePresentation"
            :presentation="djvuFailurePresentation"
            variant="soft"
            class="mx-3 mt-2"
            data-testid="workspace-document-djvu-error"
        />
        <UAlert
            v-else-if="showDjvuConversionUi && djvuError"
            color="neutral"
            variant="soft"
            class="mx-3 mt-2"
            data-testid="workspace-document-djvu-error"
            :description="String(djvuError)"
            :ui="{ title: 'sr-only' }"
        />

        <Transition name="document-status">
            <!-- Hidden, not unmounted, while converting: the convert dialog returns focus to its button. -->
            <DjvuBanner
                v-if="showDjvuBanner"
                v-show="!djvuConverting"
                @convert="handleConvert"
                @dismiss="handleDismiss"
            />
        </Transition>
    </div>
</template>

<script setup lang="ts">
import AppFailureAlert from '@app/components/AppFailureAlert.vue';
import type {FailurePresentation} from '@app/composables/useFailureToast';
import { DjvuBanner } from '@app/modules/djvu-viewer/public/component-exports/djvuBanner';

defineProps<{
    visible: boolean;
    pdfError: unknown;
    pdfFailurePresentation?: FailurePresentation | null;
    showDjvuConversionUi: boolean;
    djvuError: unknown;
    djvuFailurePresentation?: FailurePresentation | null;
    showDjvuBanner: boolean;
    djvuConverting: boolean;
}>();

const emit = defineEmits<{
    convert: [];
    dismiss: [];
}>();

const { t } = useTypedI18n();

function handleConvert() {
    emit('convert');
}

function handleDismiss() {
    emit('dismiss');
}
</script>

<style scoped>
.workspace-document-alerts-root {
    display: contents;
}
</style>
