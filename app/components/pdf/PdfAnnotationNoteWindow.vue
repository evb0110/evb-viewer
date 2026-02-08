<template>
    <div
        class="note-window"
        :style="windowStyle"
        @mousedown="emit('focus')"
        @focusin="emit('focus')"
    >
        <header
            class="note-window__title"
            @mousedown.prevent="startDrag"
        >
            <div class="note-window__title-main">
                <strong class="note-window__summary">{{ title }}</strong>
                <span class="note-window__meta">{{ authorText }}</span>
            </div>
            <div class="note-window__title-side">
                <span class="note-window__date">{{ timestampText }}</span>
                <div class="note-window__actions">
                    <button
                        type="button"
                        class="note-window__delete"
                        aria-label="Delete note"
                        @click="emit('delete')"
                    >
                        <UIcon name="i-lucide-trash-2" class="size-3.5" />
                    </button>
                    <button
                        type="button"
                        class="note-window__close"
                        aria-label="Close note"
                        @click="emit('close')"
                    >
                        <UIcon name="i-lucide-x" class="size-3.5" />
                    </button>
                </div>
            </div>
        </header>

        <textarea
            ref="noteInputRef"
            class="note-window__textarea"
            :value="text"
            rows="8"
            placeholder="Write annotation note"
            @keydown.esc.stop.prevent="emit('close')"
            @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <p v-if="saving" class="note-window__status">Saving…</p>
        <p v-if="error" class="note-window__error">{{ error }}</p>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface IAnnotationNotePosition {
    x: number;
    y: number;
}

interface IProps {
    comment: IAnnotationCommentSummary;
    text: string;
    saving?: boolean;
    error?: string | null;
    position?: IAnnotationNotePosition | null;
    zIndex?: number;
}

const {
    comment,
    text,
    saving = false,
    error = null,
    position = null,
    zIndex = 55,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:text', value: string): void;
    (e: 'update:position', value: IAnnotationNotePosition): void;
    (e: 'close'): void;
    (e: 'delete'): void;
    (e: 'focus'): void;
}>();

const noteInputRef = ref<HTMLTextAreaElement | null>(null);
const offsetX = ref(14);
const offsetY = ref(72);
const dragStartX = ref(0);
const dragStartY = ref(0);
const frameStartX = ref(0);
const frameStartY = ref(0);
const isDragging = ref(false);

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const title = computed(() => `Pop-up Note : Page ${comment.pageNumber}`);
const authorText = computed(() => comment.author?.trim() || 'Unknown Author');
const timestampText = computed(() => {
    if (!comment.modifiedAt) {
        return 'No date';
    }
    return timeFormatter.format(new Date(comment.modifiedAt));
});

const windowStyle = computed(() => ({
    left: `${offsetX.value}px`,
    top: `${offsetY.value}px`,
    zIndex: String(zIndex),
}));

function applyPosition(position: IAnnotationNotePosition | null) {
    if (!position) {
        return;
    }
    const clamped = clampPosition(position.x, position.y);
    offsetX.value = clamped.x;
    offsetY.value = clamped.y;
}

function emitPositionUpdate() {
    emit('update:position', {
        x: offsetX.value,
        y: offsetY.value,
    });
}

function clampPosition(x: number, y: number) {
    if (typeof window === 'undefined') {
        return {
            x,
            y,
        };
    }

    const maxX = Math.max(8, window.innerWidth - 320);
    const maxY = Math.max(8, window.innerHeight - 320);

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
    emitPositionUpdate();
}

function stopDrag() {
    if (!isDragging.value) {
        return;
    }

    isDragging.value = false;
    window.removeEventListener('mousemove', handlePointerMove);
    window.removeEventListener('mouseup', stopDrag);
    emitPositionUpdate();
}

function startDrag(event: MouseEvent) {
    emit('focus');
    isDragging.value = true;
    dragStartX.value = event.clientX;
    dragStartY.value = event.clientY;
    frameStartX.value = offsetX.value;
    frameStartY.value = offsetY.value;

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', stopDrag);
}

onMounted(async () => {
    applyPosition(position);
    await nextTick();
    noteInputRef.value?.focus();
});

onBeforeUnmount(() => {
    stopDrag();
});

watch(
    () => position,
    (nextPosition) => {
        if (isDragging.value) {
            return;
        }
        applyPosition(nextPosition);
    },
);

watch(
    () => comment.stableKey,
    () => {
        applyPosition(position);
        void nextTick(() => {
            noteInputRef.value?.focus();
        });
    },
);
</script>

<style scoped>
.note-window {
    position: fixed;
    z-index: 55;
    width: min(300px, calc(100vw - 18px));
    height: min(300px, calc(100vh - 86px));
    min-width: 240px;
    min-height: 220px;
    border: 1px solid #c7b75b;
    background: #fff5a0;
    box-shadow:
        0 14px 28px rgb(15 23 42 / 20%),
        0 4px 10px rgb(15 23 42 / 12%);
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    resize: both;
    overflow: hidden;
}

.note-window__title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid rgb(88 72 7 / 30%);
    padding: 0.4rem 0.5rem 0.35rem;
    cursor: move;
    user-select: none;
    background: rgb(255 255 255 / 42%);
}

.note-window__title-main {
    min-width: 0;
    display: grid;
    gap: 0.12rem;
}

.note-window__summary {
    font-size: 0.79rem;
    color: #473b08;
    line-height: 1.25;
}

.note-window__meta {
    font-size: 0.7rem;
    color: rgb(71 59 8 / 88%);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.note-window__title-side {
    display: grid;
    justify-items: end;
    gap: 0.18rem;
}

.note-window__actions {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
}

.note-window__date {
    font-size: 0.66rem;
    color: rgb(71 59 8 / 84%);
    white-space: nowrap;
}

.note-window__close {
    border: 1px solid rgb(88 72 7 / 28%);
    background: rgb(255 255 255 / 70%);
    color: #3e3307;
    width: 1.45rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__delete {
    border: 1px solid rgb(161 23 23 / 26%);
    background: rgb(255 255 255 / 72%);
    color: #a61414;
    width: 1.45rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__textarea {
    width: 100%;
    min-height: 100%;
    border: none;
    background: transparent;
    color: #2b2206;
    line-height: 1.45;
    font-size: 0.84rem;
    resize: none;
    outline: none;
    padding: 0.52rem;
}

.note-window__status {
    margin: 0;
    font-size: 0.68rem;
    color: rgb(71 59 8 / 82%);
    padding: 0 0.52rem 0.3rem;
}

.note-window__error {
    margin: 0;
    font-size: 0.7rem;
    color: #a61414;
    padding: 0 0.52rem 0.35rem;
}
</style>
