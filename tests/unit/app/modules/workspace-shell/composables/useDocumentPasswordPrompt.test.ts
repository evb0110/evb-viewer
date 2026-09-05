import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { effectScope } from 'vue';
import { useDocumentPasswordPrompt } from '@app/modules/workspace-shell/composables/useDocumentPasswordPrompt';

describe('useDocumentPasswordPrompt', () => {
    afterEach(() => {
        useDocumentPasswordPrompt().cancelPasswordPrompt();
    });

    it('resolves with the entered password and clears the prompt state', async () => {
        const prompt = useDocumentPasswordPrompt();
        const pending = prompt.requestPassword('protected.pdf');

        expect(prompt.open.value).toBe(true);
        expect(prompt.fileName.value).toBe('protected.pdf');

        prompt.submitPassword('correct horse battery staple');

        await expect(pending).resolves.toBe('correct horse battery staple');
        expect(prompt.open.value).toBe(false);
        expect(prompt.fileName.value).toBe('');
        expect(prompt.errorMessage.value).toBeNull();
    });

    it('keeps retry state visible with an inline error', async () => {
        const prompt = useDocumentPasswordPrompt();
        const firstAttempt = prompt.requestPassword('protected.pdf');
        prompt.submitPassword('wrong');
        await expect(firstAttempt).resolves.toBe('wrong');

        const retryAttempt = prompt.requestPassword(
            'protected.pdf',
            'That password is incorrect. Try again.',
        );
        expect(prompt.open.value).toBe(true);
        expect(prompt.errorMessage.value).toBe('That password is incorrect. Try again.');
        prompt.submitPassword('right');

        await expect(retryAttempt).resolves.toBe('right');
    });

    it('allows an unbounded number of retries', async () => {
        const prompt = useDocumentPasswordPrompt();

        for (let attempt = 0; attempt < 20; attempt += 1) {
            const pending = prompt.requestPassword('protected.pdf', 'wrong');
            prompt.submitPassword(`attempt-${attempt}`);
            await expect(pending).resolves.toBe(`attempt-${attempt}`);
        }
    });

    it('resolves cancellation without retaining a password', async () => {
        const prompt = useDocumentPasswordPrompt();
        const pending = prompt.requestPassword('protected.pdf');
        prompt.cancelPasswordPrompt();

        await expect(pending).resolves.toBeNull();
        expect(prompt.open.value).toBe(false);
    });

    it('cancels a pending request when its scope is disposed', async () => {
        const scope = effectScope();
        const prompt = scope.run(() => useDocumentPasswordPrompt())!;
        const pending = prompt.requestPassword('protected.pdf');

        scope.stop();

        await expect(pending).resolves.toBeNull();
        expect(prompt.open.value).toBe(false);
    });

    it('does not let an unrelated scope cancel another prompt owner', async () => {
        const ownerScope = effectScope();
        const owner = ownerScope.run(() => useDocumentPasswordPrompt())!;
        const unrelatedScope = effectScope();
        unrelatedScope.run(() => useDocumentPasswordPrompt());
        const pending = owner.requestPassword('protected.pdf');

        unrelatedScope.stop();

        expect(owner.open.value).toBe(true);
        owner.cancelPasswordPrompt();
        await expect(pending).resolves.toBeNull();
        ownerScope.stop();
    });
});
