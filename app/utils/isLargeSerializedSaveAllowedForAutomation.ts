import { isAutomationSession } from '@app/utils/isAutomationSession';

export function isLargeSerializedSaveAllowedForAutomation() {
    return isAutomationSession()
        && window.__allowLargeSerializedSaveForAutomation === true;
}
