import {describe, expect, it} from 'vitest';
import {EventEmitter} from 'node:events';
import {resolve} from 'path';
import {allowDocxWritePath, consumeAllowedDocxWritePath, normalizeDocxPath} from '@electron/file-access/docxExportPaths';

describe('docxExportPaths', () => {
    it('allows consuming a path that was provided by save dialog', () => {
        const filePath = './tmp-test-export.docx';
        const absolutePath = resolve(filePath);

        allowDocxWritePath(filePath, 10);

        expect(consumeAllowedDocxWritePath(absolutePath, 10)).toBe(true);
        expect(consumeAllowedDocxWritePath(absolutePath, 10)).toBe(false);
    });

    it('rejects consuming a grant from a different sender', () => {
        const filePath = './tmp-cross-sender-export.docx';
        const absolutePath = resolve(filePath);

        allowDocxWritePath(filePath, 10);

        expect(consumeAllowedDocxWritePath(absolutePath, 11)).toBe(false);
        expect(consumeAllowedDocxWritePath(absolutePath, 10)).toBe(true);
    });

    it('rejects paths that were never allowed', () => {
        const filePath = resolve('./tmp-never-allowed.docx');
        expect(consumeAllowedDocxWritePath(filePath, 10)).toBe(false);
    });

    it('removes sender-owned grants when the sender is destroyed', () => {
        const filePath = './tmp-destroyed-sender-export.docx';
        const absolutePath = resolve(filePath);
        const sender = new EventEmitter() as EventEmitter & {id: number};
        sender.id = 12;

        allowDocxWritePath(filePath, sender as never);
        sender.emit('destroyed');

        expect(consumeAllowedDocxWritePath(absolutePath, 12)).toBe(false);
    });

    it('removes sender-owned grants on main-frame navigation', () => {
        const filePath = './tmp-navigated-sender-export.docx';
        const absolutePath = resolve(filePath);
        const sender = new EventEmitter() as EventEmitter & {id: number};
        sender.id = 13;

        allowDocxWritePath(filePath, sender as never);
        sender.emit('did-start-navigation', {}, 'https://example.test/', false, true);

        expect(consumeAllowedDocxWritePath(absolutePath, 13)).toBe(false);
    });

    it('validates docx extension', () => {
        expect(() => normalizeDocxPath('report.txt')).toThrow('Invalid file type: only DOCX files are allowed');
    });
});
