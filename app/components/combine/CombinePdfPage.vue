<template>
    <AppToolPageShell
        :title="t('combinePdf.title')"
        :eyebrow="t('combinePdf.pageEyebrow')"
        icon="i-ph-stack-plus"
        :show-back="showBack"
        :show-eyebrow="showEyebrow"
        :show-header="showHeader"
        :body-scroll="false"
        @close="closePage"
    >
        <div
            class="combine-page"
            data-combine-page
            :class="[
                files.length > 0 ? 'has-files' : 'is-empty',
                { 'is-dragging': isDraggingOver && !queueMutationLocked },
            ]"
            @dragenter.prevent="handleDragEnter"
            @dragover.prevent="handleDragOver"
            @dragleave="handleDragLeave"
            @drop.prevent="handleDrop"
        >
            <section
                class="combine-dropzone"
                data-combine-drop-zone
            >
                <input
                    ref="fileInputRef"
                    class="sr-only"
                    type="file"
                    multiple
                    :accept="COMBINE_FILE_ACCEPT"
                    @change="handleFileInputChange"
                >
                <span class="combine-dropzone-art" aria-hidden="true">
                    <UIcon name="i-ph-files" class="combine-dropzone-icon" />
                </span>
                <div class="combine-dropzone-copy">
                    <h2>{{ t('combinePdf.dropTitle') }}</h2>
                    <p>{{ t('combinePdf.dropDescription') }}</p>
                </div>
                <UButton
                    color="primary"
                    icon="i-ph-folder-open"
                    :label="files.length > 0 ? t('combinePdf.addMore') : t('combinePdf.chooseFiles')"
                    :disabled="queueMutationLocked"
                    @click="openFileInput"
                />
                <div
                    v-if="files.length === 0 && (lastRejectedCount > 0 || combineError)"
                    class="combine-dropzone-alerts"
                >
                    <UAlert
                        v-if="lastRejectedCount > 0"
                        color="warning"
                        variant="soft"
                        icon="i-ph-warning-circle"
                        :description="t('combinePdf.unsupportedFiles', { count: lastRejectedCount })"
                    />
                    <AppFailureAlert
                        v-if="combineError && combineFailure"
                        :presentation="{
                            failure: combineFailure,
                            title: t('combinePdf.title'),
                            description: combineError,
                        }"
                    />
                    <UAlert
                        v-else-if="combineError && combineErrorIsExpected"
                        color="warning"
                        variant="soft"
                        icon="i-ph-warning-circle"
                        :description="combineError"
                    />
                </div>
            </section>

            <section
                v-if="files.length > 0"
                class="combine-workbench"
                :aria-labelledby="listTitleId"
            >
                <header class="combine-list-header">
                    <div>
                        <h2 :id="listTitleId" class="combine-list-title">
                            {{ t('combinePdf.listTitle') }}
                        </h2>
                        <p class="combine-list-meta">
                            {{ filesLabel }}
                        </p>
                    </div>
                    <UButton
                        v-if="pendingCombinedResult && !isCombining"
                        color="neutral"
                        variant="outline"
                        icon="i-ph-floppy-disk"
                        :label="t('toolbar.saveAs')"
                        @click="savePendingAs"
                    />
                    <UButton
                        v-if="pendingCombinedResult && !isCombining"
                        color="neutral"
                        variant="ghost"
                        icon="i-ph-trash"
                        :label="t('combinePdf.discardPending')"
                        @click="discardPendingResult"
                    />
                    <UButton
                        v-if="files.length > 0"
                        color="neutral"
                        variant="outline"
                        icon="i-ph-trash"
                        :label="t('combinePdf.clear')"
                        :disabled="queueMutationLocked"
                        @click="clearFiles"
                    />
                </header>

                <UAlert
                    v-if="lastRejectedCount > 0"
                    color="warning"
                    variant="soft"
                    icon="i-ph-warning-circle"
                    :description="t('combinePdf.unsupportedFiles', { count: lastRejectedCount })"
                />

                <AppFailureAlert
                    v-if="combineError && combineFailure"
                    :presentation="{
                        failure: combineFailure,
                        title: t('combinePdf.title'),
                        description: combineError,
                    }"
                />
                <UAlert
                    v-else-if="combineError && combineErrorIsExpected"
                    color="warning"
                    variant="soft"
                    icon="i-ph-warning-circle"
                    :description="combineError"
                />

                <p class="sr-only" role="status" aria-live="polite">{{ reorderAnnouncement }}</p>

                <CombinePdfFileList
                    :files="files"
                    :queue-mutation-locked="queueMutationLocked"
                    @move-file="moveFile"
                    @remove-file="removeFile"
                    @reorder="handleReorder"
                />

                <div
                    v-if="progress"
                    class="combine-progress"
                    role="status"
                    aria-live="polite"
                    :data-combine-phase="phase"
                >
                    <div class="combine-progress-copy">
                        <span>{{ phase === 'opening' ? t('combinePdf.openingTitle') : t('combinePdf.progressTitle') }}</span>
                        <span v-if="phase !== 'opening'">
                            {{ t('combinePdf.progressDetail', {
                                processed: progress.processed,
                                total: progress.total,
                            }) }}
                        </span>
                    </div>
                    <AppProgressBar :value="phase === 'opening' ? null : progress.percent" />
                </div>

                <footer class="combine-actions">
                    <p>{{ t('combinePdf.outputHint') }}</p>
                    <UButton
                        v-if="phase === 'combining' && canCancel"
                        color="neutral"
                        variant="outline"
                        icon="i-ph-x"
                        :label="t('common.cancel')"
                        @click="cancelCombine"
                    />
                    <UButton
                        color="primary"
                        icon="i-ph-stack-plus"
                        :loading="isCombining"
                        :label="primaryActionLabel"
                        @click="combineFiles"
                    />
                </footer>
            </section>
        </div>
    </AppToolPageShell>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppFailureAlert from '@app/components/AppFailureAlert.vue';
import AppToolPageShell from '@app/components/AppToolPageShell.vue';
import CombinePdfFileList from '@app/components/combine/CombinePdfFileList.vue';
import type { ICombineFile } from '@app/modules/combine/combinePdfTypes';
import {useCombinePdfQueue} from '@app/modules/combine/useCombinePdfQueue';
import {useCombinePdfOperation} from '@app/modules/combine/useCombinePdfOperation';
import {getCombinePdfCapabilities} from '@app/services/pdf/combinePdfFiles';
import {getDocumentKindFromPath} from '@app/utils/supportedDocumentPaths';
import { createBrowserSafeId } from '@app/utils/browserSafe';

const emit = defineEmits<{
    'close': [];
    'open-result': [result: TOpenFileResult];
}>();

function closePage() {
    cancelCombine();
    emit('close');
}

const {
    showBack = true,
    showEyebrow = true,
    showHeader = true,
    openResult = undefined,
} = defineProps<{
    showBack?: boolean;
    showEyebrow?: boolean;
    showHeader?: boolean;
    openResult?: ((result: TOpenFileResult) => Promise<boolean>) | undefined;
}>();

const { t } = useTypedI18n();
const listTitleId = useId();
const fileInputRef = ref<HTMLInputElement | null>(null);
const files = ref<ICombineFile[]>([]);
const reorderAnnouncement = ref('');
const isDraggingOver = ref(false);
const dragDepth = ref(0);
const combineCapabilities = getCombinePdfCapabilities();
const COMBINE_FILE_ACCEPT = combineCapabilities.supportedExtensions.join(',');

const filesLabel = computed(() => t('combinePdf.fileCount', { count: files.value.length }));

function isSupportedCombineFile(file: File) {
    const extension = file.name.toLocaleLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? '';
    return combineCapabilities.supportedExtensions.includes(extension)
        && file.size > 0
        && file.size <= combineCapabilities.maxInputBytes;
}

function toCombineFile(file: File): ICombineFile {
    return {
        id: createBrowserSafeId(),
        file,
        name: file.name,
        size: file.size,
        kind: getDocumentKindFromPath(file.name),
    };
}

const {
    phase,
    isCombining,
    progress,
    combineError,
    combineFailure,
    combineErrorIsExpected,
    pendingCombinedResult,
    queueMutationLocked,
    canCancel,
    combine: combineFiles,
    cancel: cancelCombine,
    savePendingAs,
    discardPendingResult,
} = useCombinePdfOperation({
    files,
    ...(openResult ? {openResult} : {}),
    emitOpenResult: result => emit('open-result', result),
    translate: key => t(key as never),
});

const primaryActionLabel = computed(() => {
    if (phase.value === 'combining') {
        return t('combinePdf.combining');
    }
    if (phase.value === 'opening') {
        return t('combinePdf.opening');
    }
    return pendingCombinedResult.value
        ? t('common.retry')
        : t('combinePdf.combineCountAction', { count: files.value.length });
});

const queue = useCombinePdfQueue({
    files,
    isMutationLocked: queueMutationLocked,
    isSupported: isSupportedCombineFile,
    toQueueItem: toCombineFile,
});
const {lastRejectedCount} = queue;
function addFiles(fileList: FileList | File[]) {
    combineError.value = null;
    queue.addFiles(fileList);
}

function openFileInput() {
    if (queueMutationLocked.value) {
        return;
    }
    fileInputRef.value?.click();
}

function handleFileInputChange(event: Event) {
    const input = event.target as HTMLInputElement | null;
    if (input?.files) {
        addFiles(input.files);
    }
    if (input) {
        input.value = '';
    }
}

function resetDragOverlay() {
    dragDepth.value = 0;
    isDraggingOver.value = false;
}

function handleDragEnter() {
    if (queueMutationLocked.value) {
        return;
    }
    dragDepth.value += 1;
    isDraggingOver.value = true;
}

function handleDragOver(event: DragEvent) {
    if (queueMutationLocked.value) {
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'none';
        }
        return;
    }
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
}

function handleDragLeave() {
    dragDepth.value = Math.max(0, dragDepth.value - 1);
    if (dragDepth.value === 0) {
        isDraggingOver.value = false;
    }
}

function handleDrop(event: DragEvent) {
    resetDragOverlay();
    if (event.dataTransfer?.files) {
        addFiles(event.dataTransfer.files);
    }
}

function handleWindowDragLeave(event: DragEvent) {
    if (
        typeof window !== 'undefined'
        && (
            event.clientX <= 0
            || event.clientY <= 0
            || event.clientX >= window.innerWidth
            || event.clientY >= window.innerHeight
        )
    ) {
        resetDragOverlay();
    }
}

function handleDragCancelKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        resetDragOverlay();
    }
}

const dragCancelTarget = import.meta.client ? window : undefined;

useEventListener(dragCancelTarget, 'dragend', resetDragOverlay);
useEventListener(dragCancelTarget, 'drop', resetDragOverlay);
useEventListener(dragCancelTarget, 'blur', resetDragOverlay);
useEventListener(dragCancelTarget, 'dragleave', handleWindowDragLeave);
useEventListener(dragCancelTarget, 'keydown', handleDragCancelKeydown);

function clearFiles() {
    if (!queue.clearFiles()) {
        return;
    }
    combineError.value = null;
    progress.value = null;
}

function removeFile(index: number) {
    queue.removeFile(index);
}

function announceReorder(position: number) {
    const file = files.value[position];
    if (!file) {
        return;
    }
    reorderAnnouncement.value = t('combinePdf.reorderAnnouncement', {
        name: file.name,
        position: position + 1,
        total: files.value.length,
    });
}

function moveFile(index: number, delta: -1 | 1) {
    if (queueMutationLocked.value) {
        return;
    }
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= files.value.length) {
        return;
    }

    if (!queue.moveFile(index, targetIndex)) {
        return;
    }
    announceReorder(targetIndex);
}

function handleReorder(fromIndex: number, toIndex: number) {
    if (queueMutationLocked.value) {
        return;
    }
    if (!queue.moveFile(fromIndex, toIndex)) {
        return;
    }
    announceReorder(toIndex);
}

onBeforeUnmount(cancelCombine);
</script>

<style scoped>
.combine-page {
    display: grid;
    align-items: stretch;
    gap: var(--app-combine-page-gap);
    width: min(100%, var(--app-combine-page-max-width));
    height: 100%;
    min-height: 0;
    margin: 0 auto;
}

.combine-page.is-empty {
    grid-template-columns: minmax(0, 1fr);
    width: min(100%, var(--app-combine-empty-page-max-width));
}

.combine-page.has-files {
    grid-template-columns: minmax(var(--app-combine-rail-min-width), 0.6fr) minmax(0, 1fr);
}

.combine-dropzone,
.combine-workbench {
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-start-panel-radius);
    background: var(--app-start-card-bg);
}

.combine-dropzone {
    position: sticky;
    top: 0;
    display: flex;
    align-self: start;
    min-height: var(--app-combine-dropzone-min-height);
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-combine-dropzone-gap);
    padding: var(--app-combine-dropzone-padding);
    border-style: dashed;
    border-color: var(--app-start-dropzone-border);
    background: var(--app-start-dropzone-bg);
    text-align: center;
}

.combine-page.is-empty .combine-dropzone {
    min-height: var(--app-combine-empty-dropzone-min-height);
}

.combine-page.is-dragging .combine-dropzone {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 88%, var(--ui-primary) 12%);
}

.combine-dropzone-art {
    display: inline-flex;
    width: var(--app-combine-dropzone-art-size);
    height: var(--app-combine-dropzone-art-size);
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    background: var(--ui-bg);
    color: var(--ui-primary);
}

.combine-dropzone-icon {
    width: var(--app-combine-dropzone-icon-size);
    height: var(--app-combine-dropzone-icon-size);
}

.combine-dropzone-copy {
    display: flex;
    max-width: var(--app-content-width-xs);
    flex-direction: column;
    gap: var(--app-combine-dropzone-copy-gap);
}

.combine-dropzone-copy h2 {
    margin: 0;
    color: var(--ui-text-highlighted);
    font-size: var(--app-combine-dropzone-copy-title-size);
    font-weight: var(--app-font-weight-heading);
    letter-spacing: 0;
}

.combine-dropzone-copy p {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-combine-dropzone-copy-text-size);
    line-height: var(--app-line-height-body);
}

.combine-dropzone-alerts {
    display: grid;
    width: min(100%, var(--app-combine-dropzone-alert-width));
    gap: var(--app-space-3xl);
}

.combine-workbench {
    display: flex;
    min-width: 0;
    min-height: var(--app-combine-workbench-min-height);
    max-height: 100%;
    flex-direction: column;
    gap: var(--app-combine-workbench-gap);
    overflow: hidden;
    padding: var(--app-combine-workbench-padding);
}

.combine-list-header,
.combine-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-start-panel-gap);
}

.combine-list-title {
    margin: 0;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-title-sm);
    font-weight: var(--app-font-weight-heading);
    letter-spacing: 0;
}

.combine-list-meta,
.combine-actions p {
    margin: var(--app-space-xs) 0 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.combine-progress {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    gap: var(--app-space-2xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-xl);
    background: var(--ui-bg-muted);
    padding: var(--app-combine-progress-padding);
}

.combine-progress-copy {
    display: flex;
    justify-content: space-between;
    gap: var(--app-start-panel-gap);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.combine-progress-copy span:first-child {
    color: var(--ui-text);
    font-weight: var(--app-font-weight-semibold);
}

.combine-actions {
    flex-shrink: 0;
    position: sticky;
    bottom: 0;
    margin-top: auto;
    border-top: 1px solid var(--app-start-row-divider);
    background: var(--app-start-card-bg);
    padding-top: var(--app-combine-actions-padding-top);
}

@container (max-width: 991px) {
    .combine-page.has-files {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
    }

    .combine-page.has-files .combine-workbench {
        min-height: 0;
    }

    .combine-page.has-files .combine-dropzone {
        position: static;
        min-height: 0;
        flex-direction: row;
        align-items: center;
        justify-content: flex-start;
        gap: var(--app-combine-compact-dropzone-gap);
        padding: var(--app-combine-compact-dropzone-padding);
        border-width: var(--app-combine-active-border-width);
        text-align: left;
    }

    .combine-page.has-files .combine-dropzone-art {
        width: var(--app-combine-compact-dropzone-art-size);
        height: var(--app-combine-compact-dropzone-art-size);
        flex: 0 0 auto;
        border-radius: var(--app-radius-xl);
    }

    .combine-page.has-files .combine-dropzone-icon {
        width: var(--app-combine-compact-dropzone-icon-size);
        height: var(--app-combine-compact-dropzone-icon-size);
    }

    .combine-page.has-files .combine-dropzone-copy {
        max-width: none;
        min-width: 0;
        flex: 1 1 auto;
        gap: var(--app-combine-compact-copy-gap);
    }

    .combine-page.has-files .combine-dropzone-copy h2 {
        font-size: var(--app-combine-compact-title-size);
    }

    .combine-page.has-files .combine-dropzone-copy p {
        display: none;
    }

    .combine-page.has-files .combine-dropzone :deep(button) {
        flex: 0 0 auto;
    }
}

@container (max-width: 520px) {
    .combine-list-header {
        align-items: stretch;
        flex-direction: column;
    }
}

@container (max-width: 430px) {
    .combine-actions {
        align-items: stretch;
        flex-direction: column;
    }
}
</style>
