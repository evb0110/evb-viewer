<template>
    <UIcon
        :name="iconName"
        mode="svg"
        class="file-type-icon"
        aria-hidden="true"
    />
</template>

<script setup lang="ts">
type TFileTypeKind = 'document' | 'djvu' | 'image' | 'pdf';

const FILE_TYPE_ICON_NAMES: Record<TFileTypeKind, string> = {
    pdf: 'evb:file-type-pdf',
    djvu: 'evb:file-type-djvu',
    image: 'evb:file-type-image',
    document: 'evb:file-type-document',
};

const { kind } = defineProps<{ kind: TFileTypeKind }>();

const iconName = computed(() => FILE_TYPE_ICON_NAMES[kind]);
</script>

<style scoped>
:where(.file-type-icon) {
    width: 100%;
    height: 100%;
}
</style>
