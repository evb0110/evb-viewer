import type {
    ElementHandle,
    MouseButton,
    Page,
} from 'puppeteer-core';
import type { TApplicationMenuItemQuery } from '@electron/menu';
import { activateElectronMenuItem } from '@scripts/electron-run/activateElectronMenuItem';

// A person can only click what is on top. `element.click()` inside the page
// skips hit testing, pointer and mouse-down events, focus changes and the
// hover that precedes a real click, so it reaches buttons hidden under a
// dialog or scrolled out of their panel. These helpers find the point a
// person would aim at, bring it into view with the wheel the way a person
// would, wait until it stops moving, refuse a point another element covers,
// and click it with trusted CDP input.

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
    /** Wheel distances still needed to bring the target into its scroller; both 0 when it can be clicked. */
    deltaX: number;
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
    const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll';
    const visibleBox = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left);
        let top = Math.max(0, rect.top);
        let right = Math.min(innerWidth, rect.right);
        let bottom = Math.min(innerHeight, rect.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            const scaleX = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
            const scaleY = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
            if (style.overflowX !== 'visible') {
                const contentLeft = box.left + parent.clientLeft * scaleX;
                left = Math.max(left, contentLeft);
                right = Math.min(right, contentLeft + parent.clientWidth * scaleX);
            }
            if (style.overflowY !== 'visible') {
                const contentTop = box.top + parent.clientTop * scaleY;
                top = Math.max(top, contentTop);
                bottom = Math.min(bottom, contentTop + parent.clientHeight * scaleY);
            }
        }
        return right > left && bottom > top ? {
            left,
            top,
            right,
            bottom,
        } : null;
    };
    // Aim inside the part the person can see, including all ancestor clips.
    // Prefer an already clickable match over scrolling another copy of it.
    for (const candidate of candidates) {
        if (!candidate.isConnected) continue;
        const box = visibleBox(candidate);
        if (!box) continue;
        const x = (box.left + box.right) / 2;
        const y = (box.top + box.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && candidate.contains(hit)) {
            return {
                x,
                y,
                deltaX: 0,
                deltaY: 0,
            };
        }
    }
    const distance = (start: number, end: number, boxStart: number, boxEnd: number) => (
        end > boxEnd ? end - boxEnd : start < boxStart ? start - boxStart : 0
    );
    for (const candidate of candidates) {
        if (!candidate.isConnected) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        let subject = candidate;
        for (let scroller = candidate.parentElement; scroller; scroller = scroller.parentElement) {
            const style = getComputedStyle(scroller);
            const scrollX = scrolls(style.overflowX) && scroller.scrollWidth > scroller.clientWidth;
            const scrollY = scrolls(style.overflowY) && scroller.scrollHeight > scroller.clientHeight;
            if (!scrollX && !scrollY) continue;
            const box = visibleBox(scroller);
            const subjectRect = subject.getBoundingClientRect();
            // A wheel over an offscreen panel reaches whatever is on screen
            // instead. Reveal that panel through its outer scroller first.
            subject = scroller;
            if (!box) continue;
            const deltaX = scrollX ? distance(subjectRect.left, subjectRect.right, box.left, box.right) : 0;
            const deltaY = scrollY ? distance(subjectRect.top, subjectRect.bottom, box.top, box.bottom) : 0;
            if (deltaX === 0 && deltaY === 0) continue;
            const x = (box.left + box.right) / 2;
            const y = (box.top + box.bottom) / 2;
            const hit = document.elementFromPoint(x, y);
            if (!hit || !scroller.contains(hit)) continue;
            return {
                x,
                y,
                deltaX,
                deltaY,
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

/** Resolves truthy once the target's box is the same on two consecutive frames. */
function readTargetAtRest(target: Element | string | null | undefined) {
    return new Promise<string>((resolve) => {
        const read = () => (typeof target === 'string'
            ? Array.from(document.querySelectorAll(target))
            : target ? [target] : [])
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return `${rect.left},${rect.top},${rect.width},${rect.height}`;
            })
            .join(';');
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
        if (step.deltaX === 0 && step.deltaY === 0) {
            // A person aims once the target stops moving: a menu that is
            // still scaling in, or a panel sliding into place, is not
            // clicked mid-animation.
            await page.mouse.move(step.x, step.y);
            await (await waitForTargetProbe(page, target, readTargetAtRest, deadline)).dispose();
            const settled = await waitForPointerStep(page, target, deadline);
            if (settled.deltaX === 0 && settled.deltaY === 0
                && settled.x === step.x && settled.y === step.y) {
                return {
                    x: settled.x,
                    y: settled.y,
                };
            }
            previous = null;
            continue;
        }
        // The aim point is the centre of the scroller the step selected, so the
        // same point needing the same distance again means that scroller did
        // not move; a step into another scroller is progress.
        const stalled = previous !== null
            && Math.abs(previous.x - step.x) < 1
            && Math.abs(previous.y - step.y) < 1
            && Math.abs(previous.deltaX - step.deltaX) < 1
            && Math.abs(previous.deltaY - step.deltaY) < 1;
        if (stalled) {
            throw new Error(`A person could not click ${describeTarget(target)}: the wheel does not scroll it into view`);
        }
        previous = step;
        await page.mouse.move(step.x, step.y);
        await page.mouse.wheel({
            deltaX: step.deltaX,
            deltaY: step.deltaY,
        });
        // The wheel may scroll smoothly; measure again only once the target rests.
        await (await waitForTargetProbe(page, target, readTargetAtRest, deadline)).dispose();
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

/**
 * A menu accelerator as a person presses it: the main process runs the
 * application-menu item with this id or accelerator, honouring its enabled
 * and visible state, against the window the key would reach. Page key events
 * never reach the native menu on macOS. Fails when the item cannot run.
 * Returns before the item runs, so an item that closes the window still
 * reports; wait for its effect as after a key press.
 */
export async function activateMenuItemAsUser(page: Page, query: TApplicationMenuItemQuery) {
    const result = await activateElectronMenuItem(page, query);
    if (!result.activated) {
        throw new Error(`Menu item ${JSON.stringify(query)} did not run: ${result.reason}`);
    }
    return result;
}
