<template>
    <UModal
        :open="open"
        :title="title"
        :ui="{ footer: 'justify-end gap-2' }"
        @update:open="handleOpenUpdate"
    >
        <template #description>
            <span class="sr-only">
                {{ description }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-3">
                <AppFailureAlert
                    v-if="failure"
                    :presentation="failure"
                    icon="i-ph-warning-circle"
                />
                <p v-else class="text-sm text-muted">
                    {{ description }}
                </p>
                <AppProgressBar v-if="(phase === 'checking' || phase === 'downloading') && !ready && !failure" :value="progressPercent ?? null" />
            </div>
        </template>

        <template #footer="{ close }">
            <template v-if="available || ready">
                <UButton
                    :label="t('updates.deferAction')"
                    color="neutral"
                    variant="outline"
                    @click="handleDefer"
                />
                <UButton
                    :label="t('updates.skipAction')"
                    color="neutral"
                    variant="outline"
                    @click="handleSkip"
                />
                <UButton
                    :label="available ? t('updates.downloadAction') : t('updates.installAction')"
                    color="primary"
                    @click="available ? handleDownload() : handleInstall()"
                />
            </template>
            <template v-else>
                <UButton
                    :label="t('settings.close')"
                    color="neutral"
                    variant="outline"
                    @click="close"
                />
            </template>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type { TAppUpdatePhase } from '@contracts/updatesPlatformFeature';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import AppFailureAlert from '@app/components/AppFailureAlert.vue';
import AppProgressBar from '@app/components/AppProgressBar.vue';

defineProps<{
    open: boolean;
    phase: TAppUpdatePhase;
    title: string;
    description: string;
    progressPercent?: number | null;
    available: boolean;
    ready: boolean;
    failure: FailurePresentation | null;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    defer: [];
    download: [];
    skip: [];
    install: [];
}>();

const { t } = useTypedI18n();

function handleOpenUpdate(open: boolean) {
    emit('update:open', open);
}

function handleDefer() {
    emit('defer');
}

function handleSkip() {
    emit('skip');
}

function handleDownload() {
    emit('download');
}

function handleInstall() {
    emit('install');
}
</script>
