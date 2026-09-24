import { expect } from 'vitest';

/**
 * Wall-clock budgets depend on the runner, not only on the commit, so a missed
 * budget on a shared hosted runner is not a correctness verdict. The required
 * CI verdict reports them; the nightly macOS run sets
 * EVB_E2E_TIMING_BUDGETS=enforce and fails on them.
 */
export function areTimingBudgetsEnforced() {
    return process.env.EVB_E2E_TIMING_BUDGETS === 'enforce';
}

export function reportTimingBudgetMiss(message: string) {
    console.warn(`[timing-budget] ${message} (reported; set EVB_E2E_TIMING_BUDGETS=enforce to fail on it)`);
}

export function expectWithinTimingBudget(
    actualMs: number | null | undefined,
    budgetMs: number,
    context: string,
) {
    const observedMs = actualMs ?? Number.POSITIVE_INFINITY;
    if (areTimingBudgetsEnforced()) {
        expect(observedMs, context).toBeLessThanOrEqual(budgetMs);
        return;
    }
    if (observedMs > budgetMs) {
        reportTimingBudgetMiss(`${String(observedMs)}ms exceeded the ${String(budgetMs)}ms budget: ${context}`);
    }
}
