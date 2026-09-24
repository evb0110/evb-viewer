/**
 * The preload exposes the automation file-open bridge only to an isolated
 * automation profile, so its presence marks a hidden test or agent session.
 */
export function isAutomationSession() {
    return typeof window !== 'undefined'
        && typeof window.__allowRendererFileOpenForAutomation === 'function';
}
