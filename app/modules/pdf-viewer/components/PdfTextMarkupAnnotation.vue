<template>
    <g
        class="pdf-annotation-editor-entity pdf-annotation-editor-text-markup"
        :class="{'is-selected': selected}"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="text-markup"
        :data-markup-subtype="entity.subtype"
        :style="markupStyle"
        aria-label="Text markup annotation"
    >
        <rect
            v-for="(quad, index) in entity.quadPoints"
            :key="`${entity.identity.id}-${index}`"
            :x="quad.left"
            :y="quad.top"
            :width="quad.width"
            :height="quad.height"
            rx="0.001"
        />
    </g>
</template>

<script setup lang="ts">
import type { ITextMarkupEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const props = defineProps<{
    entity: ITextMarkupEntity;
    selected: boolean;
}>();

const markupStyle = computed(() => ({
    '--annotation-color': props.entity.color ?? 'var(--app-pdf-highlight-bg)',
    '--annotation-opacity': String(props.entity.opacity ?? 0.45),
}));
</script>
