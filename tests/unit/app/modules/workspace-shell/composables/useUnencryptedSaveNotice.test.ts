import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    watch,
} from 'vue';
import {useUnencryptedSaveNotice} from '@app/modules/workspace-shell/composables/useUnencryptedSaveNotice';

const stateStore = new Map<string, ReturnType<typeof ref>>();

vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    const existing = stateStore.get(key);
    if (existing) {
        return existing;
    }
    const state = ref(init());
    stateStore.set(key, state);
    return state;
});

afterEach(() => {
    useUnencryptedSaveNotice().cancelUnencryptedSaveNotice();
    stateStore.clear();
});

describe('useUnencryptedSaveNotice', () => {
    it('queues overlapping requests until each dialog response completes', async () => {
        const first = useUnencryptedSaveNotice();
        const second = useUnencryptedSaveNotice();
        const firstRequest = first.requestUnencryptedSaveNotice();
        const secondRequest = second.requestUnencryptedSaveNotice();

        expect(first.unencryptedSaveNoticeOpen.value).toBe(true);
        expect(second.unencryptedSaveNoticeOpen.value).toBe(true);

        first.confirmUnencryptedSaveNotice();

        await expect(firstRequest).resolves.toEqual({
            confirmed: true,
            dontShowAgain: false,
        });
        expect(first.unencryptedSaveNoticeOpen.value).toBe(true);
        expect(second.unencryptedSaveNoticeDontShowAgain.value).toBe(false);

        second.cancelUnencryptedSaveNotice();

        await expect(secondRequest).resolves.toEqual({
            confirmed: false,
            dontShowAgain: false,
        });
        expect(second.unencryptedSaveNoticeOpen.value).toBe(false);
    });

    it('applies suppression to simultaneous saves without opening a second dialog', async () => {
        const first = useUnencryptedSaveNotice();
        const second = useUnencryptedSaveNotice();
        const openTransitions: boolean[] = [];
        const stopWatchingOpen = watch(
            first.unencryptedSaveNoticeOpen,
            value => openTransitions.push(value),
            {flush: 'sync'},
        );
        const saveWorkingCopy = vi.fn();
        const runSave = async (request: Promise<Awaited<ReturnType<
            typeof first.requestUnencryptedSaveNotice
        >>>) => {
            const result = await request;
            if (result.confirmed) {
                saveWorkingCopy();
            }
            return result;
        };

        const firstSave = runSave(first.requestUnencryptedSaveNotice());
        const secondSave = runSave(second.requestUnencryptedSaveNotice());
        expect(first.unencryptedSaveNoticeOpen.value).toBe(true);

        first.unencryptedSaveNoticeDontShowAgain.value = true;
        first.confirmUnencryptedSaveNotice();

        await expect(Promise.all([
            firstSave,
            secondSave,
        ])).resolves.toEqual([
            {
                confirmed: true,
                dontShowAgain: true,
            },
            {
                confirmed: true,
                dontShowAgain: true,
            },
        ]);
        expect(openTransitions).toEqual([
            true,
            false,
        ]);
        expect(saveWorkingCopy).toHaveBeenCalledTimes(2);
        stopWatchingOpen();
    });
});
