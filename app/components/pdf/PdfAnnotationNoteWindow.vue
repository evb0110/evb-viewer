<template>
    <div class="note-window" :style="windowStyle">
        <header
            class="note-window__title"
            @mousedown.prevent="startDrag"
        >
            <div class="note-window__title-main">
                <strong class="note-window__summary">{{ title }}</strong>
                <span class="note-window__meta">{{ metaText }}</span>
            </div>
            <button
                type="button"
                class="note-window__close"
                aria-label="Close note"
                @click="emit('close')"
            >
                <UIcon name="i-lucide-x" class="size-3.5" />
            </button>
        </header>

        <textarea
            class="note-window__textarea"
            :value="text"
            rows="8"
            placeholder="Write annotation note"
            @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <p v-if="error" class="note-window__error">{{ error }}</p>

        <footer class="note-window__actions">
            <UButton
                icon="i-lucide-save"
                size="sm"
                color="primary"
                :loading="saving"
                @click="emit('save')"
            >
                Save
            </UButton>
            <UButton
                icon="i-lucide-trash-2"
                size="sm"
                color="error"
                variant="soft"
                :disabled="saving"
                @click="emit('delete')"
            >
                Delete
            </UButton>
        </footer>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    ref,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface IProps {
    comment: IAnnotationCommentSummary;
    text: string;
    saving?: boolean;
    error?: string | null;
}

const {
    comment,
    text,
    saving = false,
    error = null,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:text', value: string): void;
    (e: 'save'): void;
    (e: 'delete'): void;
    (e: 'close'): void;
}>();

const offsetX = ref(24);
const offsetY = ref(86);
const dragStartX = ref(0);
const dragStartY = ref(0);
const frameStartX = ref(0);
const frameStartY = ref(0);
const isDragging = ref(false);

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const title = computed(() => `Pop-up Note · Page ${comment.pageNumber}`);
const metaText = computed(() => {
    const author = comment.author || 'Unknown Author';
    const timestamp = comment.modifiedAt
        ? timeFormatter.format(new Date(comment.modifiedAt))
        : 'No date';
    return `${author} · ${timestamp}`;
});

const windowStyle = computed(() => ({
    left: `${offsetX.value}px`,
    top: `${offsetY.value}px`,
}));

function clampPosition(x: number, y: number) {
    if (typeof window === 'undefined') {
        return {
            x,
            y,
        };
    }

    const maxX = Math.max(8, window.innerWidth - 380);
    const maxY = Math.max(8, window.innerHeight - 260);

    return {
        x: Math.min(maxX, Math.max(8, x)),
        y: Math.min(maxY, Math.max(8, y)),
    };
}

function handlePointerMove(event: MouseEvent) {
    if (!isDragging.value) {
        return;
    }

    const nextX = frameStartX.value + (event.clientX - dragStartX.value);
    const nextY = frameStartY.value + (event.clientY - dragStartY.value);
    const clamped = clampPosition(nextX, nextY);

    offsetX.value = clamped.x;
    offsetY.value = clamped.y;
}

function stopDrag() {
    if (!isDragging.value) {
        return;
    }

    isDragging.value = false;
    window.removeEventListener('mousemove', handlePointerMove);
    window.removeEventListener('mouseup', stopDrag);
}

function startDrag(event: MouseEvent) {
    isDragging.value = true;
    dragStartX.value = event.clientX;
    dragStartY.value = event.clientY;
    frameStartX.value = offsetX.value;
    frameStartY.value = offsetY.value;

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', stopDrag);
}

onBeforeUnmount(() => {
    stopDrag();
});
</script>

<style scoped>
.note-window {
    position: fixed;
    z-index: 50;
    width: min(360px, calc(100vw - 20px));
    min-height: 230px;
    border: 1px solid var(--ui-border);
    background: #fff6b8;
    box-shadow:
        0 16px 30px rgb(15 23 42 / 18%),
        0 4px 10px rgb(15 23 42 / 12%);
    display: grid;
    grid-template-rows: auto 1fr auto auto;
}

.note-window__title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.4rem;
    border-bottom: 1px solid rgb(0 0 0 / 14%);
    padding: 0.42rem 0.5rem 0.34rem;
    cursor: move;
    user-select: none;
    background: rgb(255 255 255 / 46%);
}

.note-window__title-main {
    display: flex;
    flex-direction: column;
    gap: 0.16rem;
    min-width: 0;
}

.note-window__summary {
    font-size: 0.77rem;
    color: #1f2937;
    line-height: 1.25;
}

.note-window__meta {
    font-size: 0.66rem;
    color: rgb(31 41 55 / 80%);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.note-window__close {
    border: 1px solid rgb(0 0 0 / 16%);
    background: rgb(255 255 255 / 64%);
    color: #111827;
    width: 1.45rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__textarea {
    width: 100%;
    border: none;
    background: transparent;
    color: #111827;
    line-height: 1.4;
    font-size: 0.82rem;
    resize: none;
    outline: none;
    padding: 0.5rem;
}

.note-window__error {
    margin: 0;
    font-size: 0.7rem;
    color: #b91c1c;
    padding: 0 0.5rem;
}

.note-window__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.35rem;
    border-top: 1px solid rgb(0 0 0 / 12%);
    padding: 0.42rem 0.5rem;
    background: rgb(255 255 255 / 42%);
}
</style>
