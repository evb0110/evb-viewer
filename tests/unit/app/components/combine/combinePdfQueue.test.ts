import {describe, expect, it} from 'vitest';
import {ref} from 'vue';
import {useCombinePdfQueue} from '@app/modules/combine/useCombinePdfQueue';

describe('useCombinePdfQueue', () => {
    it('preserves order, reports unsupported files, and allows intentional duplicates', () => {
        const duplicate = new File(['pdf'], 'same.pdf', {type: 'application/pdf'});
        const unsupported = new File(['text'], 'notes.txt', {type: 'text/plain'});
        const files = ref([duplicate]);
        const queue = useCombinePdfQueue({
            files,
            isMutationLocked: ref(false),
            isSupported: (file) => file.name.endsWith('.pdf'),
            toQueueItem: (file) => file,
        });
        queue.addFiles([duplicate, unsupported]);

        expect(files.value).toEqual([duplicate, duplicate]);
        expect(queue.lastRejectedCount.value).toBe(1);
    });
});
