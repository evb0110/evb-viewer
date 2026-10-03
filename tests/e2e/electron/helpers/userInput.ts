import type {
    ElementHandle,
    MouseButton,
    Page,
} from 'puppeteer-core';

// A person can only click what is on top. `element.click()` inside the page
// skips hit testing, pointer and mouse-down events, focus changes and the
// hover that precedes a real click, so it reaches buttons hidden under a
// dialog or scrolled out of their panel. These helpers find the point a
// person would aim at, bring it into view with the wheel the way a person
// would, refuse a point another element covers, and click it with trusted
// CDP input.

interface IFoundTarget<TArg> {
    /** Self-contained page function; it runs in the page on every poll, so a re-rendered target is found again. */
    find: (arg: TArg) => Element | null | undefined;
    arg: TArg;
    description: string;
}

type TClickTarget = string | ElementHandle<Element> | IFoundTarget<unknown>;

interface IClickAsUserOptions {
    button?: MouseButton;
    count?: number;
    /** Time between press and release. */
    delay?: number;
    timeoutMs?: number;
}

interface IPointerStep {
    x: number;
    y: number;
    /** Wheel distance still needed to bring the target into its scroller; 0 when it can be clicked. */
    deltaY: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function describeTarget(target: TClickTarget) {
    if (typeof target === 'string') return target;
    return 'description' in target ? target.description : 'element handle';
}

function findPointerStep(target: Element | string | null | undefined): IPointerStep | false {
    const candidates = typeof target === 'string'
        ? Array.from(document.querySelectorAll<HTMLElement>(target))
        : target ? [target as HTMLElement] : [];
    for (const candidate of candidates) {
        if (!candidate.isConnected) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && candidate.contains(hit)) {
            return {
                x,
                y,
                deltaY: 0,
            };
        }
        for (let scroller = candidate.parentElement; scroller; scroller = scroller.parentElement) {
            const overflowY = getComputedStyle(scroller).overflowY;
            if ((overflowY !== 'auto' && overflowY !== 'scroll') || scroller.scrollHeight <= scroller.clientHeight) continue;
            const box = scroller.getBoundingClientRect();
            if (rect.top >= box.top && rect.bottom <= box.bottom) continue;
            return {
                x: box.left + box.width / 2,
                y: box.top + box.height / 2,
                deltaY: rect.bottom > box.bottom ? rect.bottom - box.bottom : rect.top - box.top,
            };
        }
    }
    return false;
}

function describeObstruction(target: Element | string | null | undefined) {
    const candidates = typeof target === 'string'
        ? Array.from(document.querySelectorAll<HTMLElement>(target))
        : target ? [target as HTMLElement] : [];
    if (candidates.length === 0) return 'not rendered';
    const describe = (element: Element | null) => {
        if (!element) return 'nothing';
        const id = element.id ? `#${element.id}` : '';
        const classes = typeof element.className === 'string' && element.className
            ? `.${element.className.trim().split(/\s+/u).slice(0, 3).join('.')}`
            : '';
        return `<${element.tagName.toLowerCase()}${id}${classes}>`;
    };
    return candidates.map((candidate) => {
        if (!candidate.isConnected) return 'detached';
        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 'zero size';
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return `covered by ${describe(hit)}`;
    }).join('; ');
}

function readTargetTops(target: Element | string | null | undefined) {
    return new Promise<string>((resolve) => {
        const read = () => (typeof target === 'string'
            ? Array.from(document.querySelectorAll(target))
            : target ? [target] : [])
            .map(element => element.getBoundingClientRect().top)
            .join();
        const first = read();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(read() === first ? 'rest' : '')));
    });
}

type TTargetProbe<TResult> = (resolved: Element | string | null | undefined) => TResult;

/** A found target is resolved inside the same page task as the probe; selectors and handles go in as arguments. */
function foundTargetExpression(probe: TTargetProbe<unknown>, target: IFoundTarget<unknown>) {
    return `(${probe.toString()})((${target.find.toString()})(${JSON.stringify(target.arg ?? null)}))`;
}

function waitForTargetProbe<TResult>(page: Page, target: TClickTarget, probe: TTargetProbe<TResult>, deadline: number) {
    const options = {timeout: Math.max(1, deadline - Date.now())};
    return typeof target === 'string' || !('find' in target)
        ? page.waitForFunction(probe, options, target)
        : page.waitForFunction(foundTargetExpression(probe, target), options);
}

function evaluateTargetProbe<TResult>(page: Page, target: TClickTarget, probe: TTargetProbe<TResult>) {
    return (typeof target === 'string' || !('find' in target)
        ? page.evaluate(probe, target)
        : page.evaluate(foundTargetExpression(probe, target))) as Promise<TResult>;
}

async function waitForPointerStep(page: Page, target: TClickTarget, deadline: number) {
    try {
        const handle = await waitForTargetProbe(page, target, findPointerStep, deadline);
        const step = await handle.jsonValue() as IPointerStep;
        await handle.dispose();
        return step;
    } catch (error) {
        const reason = await evaluateTargetProbe(page, target, describeObstruction).catch(() => 'page unavailable');
        throw new Error(`A person could not click ${describeTarget(target)}: ${reason}`, {cause: error});
    }
}

/**
 * Returns the viewport point a person would click for `target`, wheeling its
 * scroll container until the target is in view and nothing covers it.
 */
export async function revealForPointer(page: Page, target: TClickTarget, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let previous: IPointerStep | null = null;
    for (;;) {
        const step = await waitForPointerStep(page, target, deadline);
        if (step.deltaY === 0) {
            return {
                x: step.x,
                y: step.y,
            };
        }
        // The aim point is the centre of the scroller the step selected, so the
        // same point needing the same distance again means that scroller did
        // not move; a step into another scroller is progress.
        const stalled = previous !== null
            && Math.abs(previous.x - step.x) < 1
            && Math.abs(previous.y - step.y) < 1
            && Math.abs(previous.deltaY - step.deltaY) < 1;
        if (stalled) {
            throw new Error(`A person could not click ${describeTarget(target)}: the wheel does not scroll it into view`);
        }
        previous = step;
        await page.mouse.move(step.x, step.y);
        await page.mouse.wheel({deltaY: step.deltaY});
        // The wheel may scroll smoothly; measure again only once the target rests.
        await (await waitForTargetProbe(page, target, readTargetTops, deadline)).dispose();
    }
}

/** Clicks `target` the way a person does, or fails naming what is in the way. */
export async function clickAsUser(page: Page, target: TClickTarget, options: IClickAsUserOptions = {}) {
    const point = await revealForPointer(page, target, options.timeoutMs);
    await page.mouse.click(point.x, point.y, {
        ...(options.button ? {button: options.button} : {}),
        ...(options.count ? {count: options.count} : {}),
        ...(options.delay ? {delay: options.delay} : {}),
    });
}

/**
 * Clicks the element a self-contained page function returns, as a person
 * would. Use it where a selector alone cannot name the target, such as a row
 * picked by its text. `find` must not close over Node values; pass them in `arg`.
 */
export async function clickFoundAsUser<TArg>(
    page: Page,
    find: (arg: TArg) => Element | null | undefined,
    arg: TArg,
    options: IClickAsUserOptions & {description: string},
) {
    await clickAsUser(page, {
        find: find as IFoundTarget<unknown>['find'],
        arg,
        description: options.description,
    }, options);
}
