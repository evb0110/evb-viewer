<template>
    <span class="document-session-host" hidden />
</template>

<script setup lang="ts">
import {
    createDocumentContext,
    useDocumentContextRegistry,
} from '@app/modules/workspace-shell/documentContext';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

defineOptions({ name: 'DocumentSessionHost' });

// One per document controller, outside every tab's mount, so the document's
// file, annotations, history and save outlive the views that show it.
const { documentController } = defineProps<{documentController: IWorkspaceDocumentController}>();

const registry = useDocumentContextRegistry();
const context = createDocumentContext({controller: documentController});
registry.set(documentController, context);
const {file} = context;
// Keep the assigned identity until the hosted file changes, then publish it
// for every view from this one document lifetime.
watch(() => {
    const djvuSource = file.isDjvuMode.value ? file.djvuSourcePath.value : null;
    return {
        fileName: djvuSource ? getDocumentRefBaseName(djvuSource) ?? file.fileName.value : file.fileName.value,
        originalPath: djvuSource ?? file.originalPath.value,
        isDjvu: file.isDjvuMode.value,
        revisionInfo: file.documentRevisionInfo.value,
    };
}, document => documentController.commitDocument(document));
onBeforeUnmount(() => {
    registry.delete(documentController);
});
// EditorPanesHost fails this document when its context throws.
defineExpose({documentController});
</script>
