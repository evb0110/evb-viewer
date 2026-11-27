#!/usr/bin/env node
// Generates resources/dmg-background.png and resources/dmg-background@2x.png.
//
// Geometry contract with electron-builder.yml (dmg section): when dmg.background
// is set, dmg-builder derives the Finder window size from the 1x image pixel
// size and ignores dmg.window. The icons sit at (160,185) and (440,185) with
// iconSize 128, so the arrow is drawn on the same y=185 axis between them.
// dmg-builder auto-combines the 1x and @2x files into a HiDPI TIFF via
// tiffutil, so both files must stay in sync.

import {createRequire} from 'node:module';
import {readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveCanvasModule() {
    const require = createRequire(import.meta.url);
    try {
        return require('@napi-rs/canvas');
    } catch {
        const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
        const entry = readdirSync(pnpmDir).find((name) => name.startsWith('@napi-rs+canvas@'));
        if (!entry) {
            throw new Error('@napi-rs/canvas not found in node_modules/.pnpm');
        }
        return require(path.join(pnpmDir, entry, 'node_modules', '@napi-rs', 'canvas'));
    }
}

const {createCanvas} = resolveCanvasModule();

const WIDTH = 600;
const HEIGHT = 450;
const ICON_CENTER_Y = 185;
const APP_ICON_X = 160;
const APPLICATIONS_X = 440;
const ICON_HALF = 64;

const COLOR_BG_TOP = '#EAEEF4';
const COLOR_BG_BOTTOM = '#D5DBE4';
const COLOR_TITLE = '#1E3A5F';
const COLOR_ARROW = '#3B82F6';

function drawBackground(scale) {
    const canvas = createCanvas(WIDTH * scale, HEIGHT * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    gradient.addColorStop(0, COLOR_BG_TOP);
    gradient.addColorStop(1, COLOR_BG_BOTTOM);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = COLOR_TITLE;
    ctx.font = '600 26px "Helvetica Neue", "SF Pro Display", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EVB Viewer', WIDTH / 2, 62);

    const shaftStart = APP_ICON_X + ICON_HALF + 26;
    const headTip = APPLICATIONS_X - ICON_HALF - 24;
    const headLength = 26;
    const headHalfWidth = 17;
    const shaftEnd = headTip - headLength + 6;

    ctx.strokeStyle = COLOR_ARROW;
    ctx.lineWidth = 11;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shaftStart, ICON_CENTER_Y);
    ctx.lineTo(shaftEnd, ICON_CENTER_Y);
    ctx.stroke();

    ctx.fillStyle = COLOR_ARROW;
    ctx.beginPath();
    ctx.moveTo(headTip, ICON_CENTER_Y);
    ctx.lineTo(headTip - headLength, ICON_CENTER_Y - headHalfWidth);
    ctx.lineTo(headTip - headLength, ICON_CENTER_Y + headHalfWidth);
    ctx.closePath();
    ctx.fill();

    return canvas.toBuffer('image/png');
}

writeFileSync(path.join(repoRoot, 'resources', 'dmg-background.png'), drawBackground(1));
writeFileSync(path.join(repoRoot, 'resources', 'dmg-background@2x.png'), drawBackground(2));
console.log('Wrote resources/dmg-background.png (600x450) and resources/dmg-background@2x.png (1200x900)');
