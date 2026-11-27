import {describe, expect, it} from 'vitest';
import {effectScope} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import {useDocumentSourceSession} from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';

describe('useDocumentSourceSession', () => {
    it('owns source identity and capabilities without a format mode flag', () => {
        const scope = effectScope();
        const session = scope.run(() => useDocumentSourceSession());
        if (!session) {
            throw new Error('Failed to create document source session');
        }

        session.activateDocumentSource('djvu', requireDocumentRef('/books/source.djvu'));

        expect(session.sourceKind.value).toBe('djvu');
        expect(session.sourceRef.value).toBe('/books/source.djvu');
        expect(session.isDjvuSource.value).toBe(true);
        expect(session.capabilities.value).toMatchObject({
            directImageExport: true,
            pageEdits: false,
        });

        session.clearDocumentSource();
        expect(session.sourceKind.value).toBeNull();
        expect(session.sourceRef.value).toBeNull();
        expect(session.isDjvuSource.value).toBe(false);
        scope.stop();
    });

    it('does not let an older activation clear a newer source with the same path', () => {
        const scope = effectScope();
        const session = scope.run(() => useDocumentSourceSession());
        if (!session) {
            throw new Error('Failed to create document source session');
        }

        const older = session.activateDocumentSource('djvu', requireDocumentRef('/books/source.djvu'));
        const newer = session.activateDocumentSource('djvu', requireDocumentRef('/books/source.djvu'));

        expect(session.clearDocumentSource(older)).toBe(false);
        expect(session.captureDocumentSourceActivation()).toEqual(newer);
        expect(session.sourceRef.value).toBe('/books/source.djvu');
        expect(session.isDjvuSource.value).toBe(true);

        expect(session.clearDocumentSource(newer)).toBe(true);
        expect(session.captureDocumentSourceActivation()).toBeNull();
        expect(session.sourceRef.value).toBeNull();
        scope.stop();
    });
});
