<template>
    <span class="document-session-host" hidden />
</template>

<script setup lang="ts">
import {
    createDocumentContext,
    useDocumentContextRegistry,
} from '@app/modules/workspace-shell/documentContext';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

defineOptions({ name: 'DocumentSessionHost' });

// One per document controller, outside every tab's mount, so the document's
// file, annotations, history and save outlive the views that show it.
const { documentController } = defineProps<{documentController: IWorkspaceDocumentController}>();

const registry = useDocumentContextRegistry();
registry.set(documentController, createDocumentContext({controller: documentController}));
onBeforeUnmount(() => {
    registry.delete(documentController);
});
// EditorPanesHost fails this document when its context throws.
defineExpose({documentController});
</script>
