import {
    describe,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';

function createSession() {
    return useWorkspaceAnnotationSession({
        pdfViewerRef: ref(null),
        pdfDocument: ref(null),
        dragMode: ref(false),
    });
}

describe('useWorkspaceAnnotationSession', () => {
    it('resets canonical annotation tracking after a save', () => {
        const session = createSession();

        session.markAnnotationSaved();

        session.resetAnnotationTracking();
    });
});
