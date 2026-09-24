import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkspaceTabUpdate } from '@app/modules/workspace-shell/state/resolveWorkspaceTabUpdate';
import { requireDocumentRef } from '@contracts/documentRef';

describe('resolveWorkspaceTabUpdate', () => {
    it('emits DjVu source path as tab originalPath when DjVu mode is active', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'temp.pdf',
            pendingOpenDisplayName: null,
            originalPath: requireDocumentRef('/tmp/temp.pdf'),
            isDirty: true,
            isDjvuMode: true,
            djvuSourcePath: requireDocumentRef('/docs/source/book.djvu'),
        });

        expect(update).toEqual({
            fileName: 'book.djvu',
            originalPath: '/docs/source/book.djvu',
            isDirty: true,
            isDjvu: true,
        });
    });

    it('decodes browser-encoded DjVu source names for the tab label', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'temp.pdf',
            pendingOpenDisplayName: null,
            originalPath: requireDocumentRef('browser://documents/working/temp.pdf'),
            isDirty: true,
            isDjvuMode: true,
            djvuSourcePath: requireDocumentRef('browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu'),
        });

        expect(update).toEqual({
            fileName: 'Глава.djvu',
            originalPath: 'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu',
            isDirty: true,
            isDjvu: true,
        });
    });

    it('keeps PDF metadata when DjVu mode is inactive', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'paper.pdf',
            pendingOpenDisplayName: null,
            originalPath: requireDocumentRef('/docs/paper.pdf'),
            isDirty: false,
            isDjvuMode: false,
            djvuSourcePath: requireDocumentRef('/docs/source/book.djvu'),
        });

        expect(update).toEqual({
            fileName: 'paper.pdf',
            originalPath: '/docs/paper.pdf',
            isDirty: false,
            isDjvu: false,
        });
    });
});
