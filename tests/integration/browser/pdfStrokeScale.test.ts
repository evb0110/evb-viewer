import {describe, expect, it} from 'vitest';
import {toPdfScaledCssLength} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import {closeChromiumBrowser, connectOrLaunchChromium} from './browserIntegrationChromium';

describe('PDF stroke scale in Chromium', () => {
    it('repaints an SVG stroke when only the live page scale variable changes', async () => {
        const browser = await connectOrLaunchChromium();
        try {
            const page = await browser.newPage();
            await page.setContent('<!doctype html><main id="host"></main>');
            const result = await page.evaluate((strokeWidth) => {
                const namespace = 'http://www.w3.org/2000/svg';
                const host = document.querySelector<HTMLElement>('#host')!;
                host.style.setProperty('--total-scale-factor', '2.55');
                const svg = document.createElementNS(namespace, 'svg');
                svg.setAttribute('width', '100');
                svg.setAttribute('height', '100');
                svg.setAttribute('viewBox', '0 0 1 1');
                svg.setAttribute('preserveAspectRatio', 'none');
                const line = document.createElementNS(namespace, 'line');
                line.setAttribute('x1', '0');
                line.setAttribute('y1', '0.5');
                line.setAttribute('x2', '1');
                line.setAttribute('y2', '0.5');
                line.setAttribute('stroke', 'black');
                line.setAttribute('vector-effect', 'non-scaling-stroke');
                line.setAttribute('stroke-width', strokeWidth);
                svg.append(line);
                host.append(svg);

                const initialWidth = Number.parseFloat(getComputedStyle(line).strokeWidth);
                const initialRect = svg.getBoundingClientRect();
                host.style.setProperty('--total-scale-factor', '3.02');
                const updatedWidth = Number.parseFloat(getComputedStyle(line).strokeWidth);
                const updatedRect = svg.getBoundingClientRect();
                return {
                    initialWidth,
                    updatedWidth,
                    initialSize: [initialRect.width, initialRect.height],
                    updatedSize: [updatedRect.width, updatedRect.height],
                };
            }, toPdfScaledCssLength(2));

            expect(result.initialWidth).toBeCloseTo(5.1, 5);
            expect(result.updatedWidth).toBeCloseTo(6.04, 5);
            expect(result.updatedSize).toEqual(result.initialSize);
        } finally {
            await closeChromiumBrowser(browser);
        }
    });
});
