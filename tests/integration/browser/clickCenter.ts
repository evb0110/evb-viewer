import type {Page} from 'playwright';

export async function clickCenter(page: Page, selector: string, button: 'left' | 'right' = 'left') {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) {
        throw new Error(`${selector} has no visible box`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {button});
}

