<template>
    <div
        class="pdf-annotation-editor-entity pdf-annotation-editor-stamp"
        :class="{'is-selected': selected}"
        :style="rectStyle"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="placed-image"
        :aria-label="t('annotations.imageLabel')"
    >
        <img
            v-if="imageUrl"
            class="pdf-annotation-editor-stamp__image"
            :src="imageUrl"
            alt=""
            draggable="false"
        />
        <UIcon v-else name="i-ph-image" />
    </div>
</template>

<script setup lang="ts">
import type { IPlacedImageEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { annotationEditorSurfaceKey } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IAnnotationMarkerRect } from '@app/types/annotations';

const props = defineProps<{
    entity: IPlacedImageEntity;
    selected: boolean;
    displayRect?: IAnnotationMarkerRect | undefined;
}>();
const { t } = useTypedI18n();
const annotationEditorSurface = inject(annotationEditorSurfaceKey, null);
const imageUrl = shallowRef<string | null>(null);
let imageLoadGeneration = 0;

async function resolveImage(entity: IPlacedImageEntity) {
    const generation = ++imageLoadGeneration;
    imageUrl.value = null;
    let resolved: string | null = null;
    try {
        resolved = await annotationEditorSurface?.resolveStampImage?.(entity) ?? null;
    } catch (error) {
        BrowserLogger.warn('pdf-annotations', 'Failed to resolve canonical stamp image', error);
    }
    if (generation === imageLoadGeneration) {
        imageUrl.value = resolved;
    }
}

watch(() => props.entity.image, () => {
    void resolveImage(props.entity);
}, {
    immediate: true,
    deep: true,
});

onBeforeUnmount(() => {
    imageLoadGeneration += 1;
});

const rectStyle = computed(() => ({
    left: `${(props.displayRect ?? props.entity.rect).left * 100}%`,
    top: `${(props.displayRect ?? props.entity.rect).top * 100}%`,
    width: `${(props.displayRect ?? props.entity.rect).width * 100}%`,
    height: `${(props.displayRect ?? props.entity.rect).height * 100}%`,
    transform: `rotate(${props.entity.rotation}deg)`,
}));
</script>
