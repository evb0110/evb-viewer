import { getErrorMessage } from '@electron/utils/error';
import { waitForBoundedAssistantInterrupt } from '@electron/features/agent/assistantTurnLiveness';

export async function runAssistantShutdownStep(
    label: string,
    run: () => unknown | Promise<unknown>,
    logger: {warn(message: string): void},
) {
    try {
        await waitForBoundedAssistantInterrupt(Promise.resolve(run()));
    } catch (error) {
        logger.warn(`Failed to shut down ${label}: ${getErrorMessage(error)}`);
    }
}
