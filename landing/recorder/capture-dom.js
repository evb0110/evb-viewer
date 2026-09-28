// Page-side capture: prepares the live DOM so dom-to-svg reproduces what the browser paints,
// captures, then undoes every change. Injected together with d2s.bundle.js.
// Every correction is made IN PLACE (same stacking context, same clipping) so later paint order is right.
window.__filmCapture = async function filmCapture({
    width,
    height: viewportHeight,
    prefix,
    fullPage,
}) {
    const undo = [];
    const setStyle = (el, props) => {
        const old = {};
        for (const k of Object.keys(props)) old[k] = [
            el.style.getPropertyValue(k),
            el.style.getPropertyPriority(k),
        ];
        undo.push(() => {
            for (const [
                k,
                [
                    v,
                    p,
                ],
            ] of Object.entries(old)) el.style.setProperty(k, v, p);
        });
        for (const [
            k,
            v,
        ] of Object.entries(props)) el.style.setProperty(k, v, 'important');
    };
    const added = [];
    const addNode = (node, insert) => {
        insert(node);
        added.push(node);
    };

    // Resolve any CSS colour (oklch, color-mix, ...) to rgba() via a 1x1 canvas.
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const toRgb = (color) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [
            r,
            g,
            b,
            a,
        ] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    };

    // Absolutely positioned sibling placed at page coordinates (x, y), whatever the containing block is.
    const placeSibling = (target, node, x, y) => {
        Object.assign(node.style, {
            position: 'absolute',
            left: '0px',
            top: '0px',
            margin: '0',
            pointerEvents: 'none',
        });
        target.after(node);
        added.push(node);
        const r0 = node.getBoundingClientRect();
        node.style.left = `${x - r0.left}px`;
        node.style.top = `${y - r0.top}px`;
    };

    const effectiveOpacity = (el) => {
        let o = 1;
        for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity) || 0;
        return o;
    };
    const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    };

    // 0. Style changes made below must apply instantly, not animate (transition-colors etc.).
    const noTransitions = document.createElement('style');
    noTransitions.textContent = '*,*::before,*::after{transition:none!important}';
    addNode(noTransitions, (n) => document.head.append(n));
    void document.body.offsetHeight;

    // 1. Development-only chrome.
    for (const el of document.querySelectorAll('#nuxt-devtools-container, nuxt-devtools-frame, #nuxt-devtools-anchor')) {
        setStyle(el, { display: 'none' });
    }

    // 2. Unroll inner scroll containers for full-page captures.
    if (fullPage) {
        for (const el of document.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40) {
                setStyle(el, {
                    'overflow-y': 'visible',
                    height: 'auto',
                    'max-height': 'none',
                });
                for (let p = el.parentElement; p; p = p.parentElement) {
                    setStyle(p, {
                        height: 'auto',
                        'max-height': 'none',
                        'overflow-y': 'visible',
                    });
                }
            }
        }
    }
    const height = fullPage ? Math.max(viewportHeight, document.documentElement.scrollHeight) : viewportHeight;

    // 2b. Visually hidden elements (sr-only: clip-path inset(50%) / clip rect(0 0 0 0)) - dom-to-svg ignores clipping.
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (/inset\((50|100)%\)/.test(cs.clipPath) || /rect\(0px,? 0px,? 0px,? 0px\)/.test(cs.clip)) setStyle(el, { visibility: 'hidden' });
    }

    // 2c. text-overflow: ellipsis - truncate overflowing single-text elements to what the browser shows.
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.textOverflow !== 'ellipsis' || el.scrollWidth <= el.clientWidth + 1) continue;
        if (el.childNodes.length !== 1 || el.firstChild.nodeType !== Node.TEXT_NODE) continue;
        const node = el.firstChild;
        const original = node.nodeValue;
        undo.push(() => {
            node.nodeValue = original;
        });
        let lo = 0;
        let hi = original.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            node.nodeValue = `${original.slice(0, mid).trimEnd()}…`;
            if (el.scrollWidth <= el.clientWidth + 1) lo = mid;
            else hi = mid - 1;
        }
        node.nodeValue = `${original.slice(0, lo).trimEnd()}…`;
    }

    // 2d. Huge radii (Tailwind rounded-full = calc(infinity * 1px)) -> the radius the browser actually paints.
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        const rad = parseFloat(cs.borderTopLeftRadius);
        if (!(rad > 1000)) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        setStyle(el, { 'border-radius': `${Math.min(r.width, r.height) / 2}px` });
    }

    // 2e. overflow:hidden + rounded parent: dom-to-svg does not clip children, so give children that
    //     fill the parent the parent's radius (radio dots, avatars, pill buttons).
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.overflow === 'visible' || !(parseFloat(cs.borderTopLeftRadius) > 0)) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        for (const child of el.querySelectorAll('*')) {
            const c = child.getBoundingClientRect();
            if (Math.abs(c.left - r.left) < 1.5 && Math.abs(c.top - r.top) < 1.5 && Math.abs(c.width - r.width) < 1.5 && Math.abs(c.height - r.height) < 1.5) {
                setStyle(child, { 'border-radius': cs.borderRadius });
            }
        }
    }

    // 3. Canvases (PDF pages) -> in-place images.
    const canvasInfo = [];
    for (const cv of document.querySelectorAll('canvas')) {
        if (!isVisible(cv)) continue;
        let url;
        try {
            url = cv.toDataURL('image/webp', 0.8);
        } catch (e) {
            canvasInfo.push(`ERR ${e.name}`);
            continue;
        }
        const cr = cv.getBoundingClientRect();
        canvasInfo.push(`${Math.round(cr.top)}:${cv.width}x${cv.height}:${url.length}`);
        const r = cv.getBoundingClientRect();
        const img = document.createElement('img');
        const cs = getComputedStyle(cv);
        for (let i = 0; i < cs.length; i++) img.style.setProperty(cs[i], cs.getPropertyValue(cs[i]));
        img.style.width = `${r.width}px`;
        img.style.height = `${r.height}px`;
        img.src = url;
        addNode(img, (n) => cv.before(n));
        setStyle(cv, { display: 'none' });
    }

    // 3a. dom-to-svg paints in DOM order and ignores z-index, so a fixed element covering the viewport
    //     (EVB Player's full window mode) would be drawn under later siblings. Hide what it covers.
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || !(parseInt(cs.zIndex, 10) > 0) || !isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 0.9 * width * viewportHeight) continue;
        for (const other of document.querySelectorAll('body *')) {
            if (!el.contains(other) && !other.contains(el)) setStyle(other, { visibility: 'hidden' });
        }
        break;
    }

    // 3b. Videos -> in-place images. dom-to-svg cannot draw a <video>; the recorder supplies the
    //     current frame per media file name (window.__filmVideoFrames), drawn with the element's object-fit.
    for (const video of document.querySelectorAll('video')) {
        if (!isVisible(video)) continue;
        let name = '';
        try {
            const src = new URL(video.currentSrc || video.src);
            name = (src.searchParams.get('path') ?? decodeURIComponent(src.pathname)).split(/[\\/]/).pop();
        } catch {
            continue;
        }
        const frame = window.__filmVideoFrames?.[name];
        if (!frame) {
            canvasInfo.push(`video without frame: ${name}`);
            continue;
        }
        const r = video.getBoundingClientRect();
        const img = document.createElement('img');
        const cs = getComputedStyle(video);
        for (let i = 0; i < cs.length; i++) img.style.setProperty(cs[i], cs.getPropertyValue(cs[i]));
        img.style.width = `${r.width}px`;
        img.style.height = `${r.height}px`;
        img.style.objectFit = cs.objectFit === 'fill' ? 'contain' : cs.objectFit;
        img.src = frame;
        addNode(img, (n) => video.before(n));
        setStyle(video, { display: 'none' });
    }

    // 3b2. Images with blob: URLs (EVB Viewer's scan cleanup previews) only exist in the app's session,
    //      so the SVG would point at nothing. Swap in a data URL of the same pixels.
    const blobLoads = [];
    for (const image of document.querySelectorAll('img')) {
        if (!image.currentSrc.startsWith('blob:') || !image.naturalWidth) continue;
        const surface = document.createElement('canvas');
        surface.width = image.naturalWidth;
        surface.height = image.naturalHeight;
        surface.getContext('2d').drawImage(image, 0, 0);
        const original = image.getAttribute('src');
        undo.push(() => image.setAttribute('src', original));
        image.src = surface.toDataURL('image/webp', 0.85);
        blobLoads.push(image.decode().catch(() => {}));
    }
    await Promise.all(blobLoads);

    // 3c. Range inputs: dom-to-svg writes their value as text instead of drawing a slider. Draw the
    //     track, fill and thumb the app paints (EVB Player's .seek-range/.volume-range) and hide the input.
    for (const range of document.querySelectorAll('input[type="range"]')) {
        if (!isVisible(range)) continue;
        const r = range.getBoundingClientRect();
        const cs = getComputedStyle(range);
        const min = Number(range.min || 0);
        const max = Number(range.max || 100);
        const fill = max > min ? Math.min(1, Math.max(0, (Number(range.value) - min) / (max - min))) : 0;
        const accent = cs.getPropertyValue('--shell-accent').trim() || '#f0784e';
        const track = parseFloat(cs.getPropertyValue('--range-track-height')) || 4;
        const thumb = (parseFloat(cs.getPropertyValue('--range-thumb-size')) || 12) * 0.75;
        // Same box as the input, in the same place in the layout: dom-to-svg writes the value of any
        // rendered input as text, so the input itself must not render.
        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'relative',
            display: 'block',
            flex: 'none',
            width: `${r.width}px`,
            height: `${r.height}px`,
            margin: cs.margin,
            alignSelf: cs.alignSelf,
        });
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            position: 'absolute',
            left: '0px',
            top: `${(r.height - track) / 2}px`,
            width: `${r.width}px`,
            height: `${track}px`,
            borderRadius: `${track / 2}px`,
            background: 'rgba(255, 255, 255, 0.18)',
            overflow: 'hidden',
        });
        const done = document.createElement('div');
        Object.assign(done.style, {
            width: `${fill * 100}%`,
            height: '100%',
            background: accent,
        });
        bar.append(done);
        const knob = document.createElement('div');
        Object.assign(knob.style, {
            position: 'absolute',
            left: `${fill * (r.width - thumb)}px`,
            top: `${(r.height - thumb) / 2}px`,
            width: `${thumb}px`,
            height: `${thumb}px`,
            borderRadius: '50%',
            background: accent,
        });
        box.append(bar, knob);
        addNode(box, (n) => range.before(n));
        setStyle(range, { display: 'none' });
    }

    // 3d. dom-to-svg turns a linear-gradient without a direction into a zero-length gradient that paints
    //     as a solid block. Chrome drops the default 180deg from computed styles, so use a direction it keeps.
    for (const el of document.querySelectorAll('body *')) {
        const image = getComputedStyle(el).backgroundImage;
        if (!image.includes('linear-gradient(')) continue;
        const fixed = image.replace(/linear-gradient\((?!\s*(?:to\s|-?[\d.]+(?:deg|turn|rad|grad)))/g, 'linear-gradient(180.01deg, ');
        if (fixed !== image) setStyle(el, { 'background-image': fixed });
    }

    // 4. Pseudo-elements -> real spans.
    const pseudoStyle = document.createElement('style');
    addNode(pseudoStyle, (n) => document.head.append(n));
    let pseudoCount = 0;
    const pseudoHosts = [];
    for (const el of document.querySelectorAll('body *')) {
        if (el.closest('svg') || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
        for (const which of [
            '::before',
            '::after',
        ]) {
            const ps = getComputedStyle(el, which);
            const content = ps.content;
            if (!content || content === 'none' || content === 'normal' || ps.display === 'none') continue;
            const text = /^["'].*["']$/.test(content)
                ? content.slice(1, -1).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
                : '';
            const span = document.createElement('span');
            for (let i = 0; i < ps.length; i++) span.style.setProperty(ps[i], ps.getPropertyValue(ps[i]));
            span.textContent = text;
            const cls = `film-ps-${pseudoCount++}`;
            el.classList.add(cls);
            pseudoHosts.push([
                el,
                cls,
            ]);
            pseudoStyle.append(`.${cls}${which}{display:none!important}\n`);
            addNode(span, (n) => (which === '::before' ? el.prepend(n) : el.append(n)));
        }
    }

    // 5. dom-to-svg's gradient parser only knows legacy colour syntax.
    const MODERN = /(oklab|oklch|lab|lch|color-mix|color)\((?:[^()]|\([^()]*\))*\)/;
    for (const el of document.querySelectorAll('*')) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg.includes('gradient(') || !MODERN.test(bg)) continue;
        let fixed = bg;
        for (let guard = 0; guard < 60 && MODERN.test(fixed); guard++) fixed = fixed.replace(MODERN, (c) => toRgb(c));
        setStyle(el, { 'background-image': fixed });
    }

    // 6. CSS-mask icons (Iconify CSS mode) -> <img> child inside the icon element itself.
    const iconLoads = [];
    for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        const mask = cs.maskImage || cs.webkitMaskImage;
        if (!mask || !mask.startsWith('url("')) continue;
        if (!isVisible(el) || [
            'IMG',
            'INPUT',
            'SVG',
        ].includes(el.tagName)) continue;
        const src = mask.slice(5, mask.indexOf('")'));
        let data = null;
        if (src.startsWith('data:image/svg+xml;base64,')) data = atob(src.slice(26));
        else if (src.startsWith('data:image/svg+xml')) data = decodeURIComponent(src.slice(src.indexOf(',') + 1));
        else if (/^https?:/.test(src)) data = await fetch(src).then((res) => res.text()).catch(() => null);
        if (!data || !data.includes('<svg')) continue;
        const color = toRgb(cs.backgroundColor);
        // Masks only use alpha, so any paint colour is the icon colour.
        const tinted = data.replace(/(fill|stroke)=(['"])(?!none)[^'"]*\2/g, `$1=$2${color}$2`).replace('<svg', `<svg fill="${color}"`);
        const img = document.createElement('img');
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tinted)}`;
        Object.assign(img.style, {
            display: 'block',
            width: '100%',
            height: '100%',
        });
        setStyle(el, {
            'background-color': 'transparent',
            'mask-image': 'none',
            '-webkit-mask-image': 'none',
        });
        addNode(img, (n) => el.append(n));
        iconLoads.push(img.decode().catch(() => {}));
    }
    await Promise.all(iconLoads);

    // 6b. Circular borders (CSS spinners: border-radius 50%, one coloured side) -> SVG ring image.
    //     dom-to-svg draws borders as straight lines, so a spinner comes out as a square.
    const ringLoads = [];
    for (const el of document.querySelectorAll('body *')) {
        if (el.closest('svg') || !isVisible(el)) continue;
        const cs = getComputedStyle(el);
        // Layout size, not the bounding box: a rotated spinner's box grows with the angle.
        const r = {
            width: el.offsetWidth,
            height: el.offsetHeight,
        };
        const w = parseFloat(cs.borderTopWidth) || 0;
        if (!w || !r.width || Math.abs(r.width - r.height) > 1) continue;
        if (!(parseFloat(cs.borderTopLeftRadius) >= r.width / 2 - 1)) continue;
        const sides = [
            'Top',
            'Right',
            'Bottom',
            'Left',
        ].map((s) => ({
            color: toRgb(cs[`border${s}Color`]),
            width: parseFloat(cs[`border${s}Width`]) || 0,
            style: cs[`border${s}Style`],
        }));
        if (sides.some((s) => s.style !== 'solid' || Math.abs(s.width - w) > 0.5)) continue;
        const size = r.width;
        const rad = (size - w) / 2;
        const c = size / 2;
        const pt = (deg) => {
            const a = (deg * Math.PI) / 180;
            return `${c + rad * Math.cos(a)} ${c + rad * Math.sin(a)}`;
        };
        // Each side owns the quarter of the ring centred on it (top = -135deg..-45deg).
        const arcs = sides.map((s, i) => {
            const from = -135 + i * 90;
            return `<path d="M ${pt(from)} A ${rad} ${rad} 0 0 1 ${pt(from + 90)}" fill="none" stroke="${s.color}" stroke-width="${w}"/>`;
        });
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${arcs.join('')}</svg>`;
        const img = document.createElement('img');
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        Object.assign(img.style, {
            position: 'absolute',
            left: `${-w}px`,
            top: `${-w}px`,
            width: `${size}px`,
            height: `${size}px`,
            maxWidth: 'none',
        });
        if (cs.position === 'static') setStyle(el, { position: 'relative' });
        // A frozen rotation differs per state and makes the ring jump between frames; record it at rest.
        setStyle(el, {
            'border-color': 'transparent',
            animation: 'none',
            transform: 'none',
            rotate: 'none',
        });
        addNode(img, (n) => el.append(n));
        ringLoads.push(img.decode().catch(() => {}));
    }
    await Promise.all(ringLoads);

    // 7. Tailwind rings (zero-blur box-shadows) -> bordered sibling at the same place.
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.boxShadow === 'none' || !isVisible(el) || el.parentElement?.tagName === 'TR') continue;
        const r = el.getBoundingClientRect();
        let replaced = false;
        for (const part of cs.boxShadow.split(/,(?![^(]*\))/)) {
            const color = (part.match(/rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]+/i) || [])[0];
            const nums = part.replace(/rgba?\([^)]*\)|okl(?:ch|ab)\([^)]*\)/gi, '').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
            const [
                ox = 0,
                oy = 0,
                blur = 0,
                spread = 0,
            ] = nums;
            if (!color || blur !== 0 || spread <= 0) continue;
            const rgb = toRgb(color);
            if (rgb.endsWith(', 0.000)')) continue;
            const inset = part.includes('inset');
            const grow = inset ? 0 : spread;
            const ring = document.createElement('div');
            Object.assign(ring.style, {
                width: `${r.width + grow * 2}px`,
                height: `${r.height + grow * 2}px`,
                border: `${spread}px solid ${rgb}`,
                borderRadius: cs.borderRadius,
                boxSizing: 'border-box',
                zIndex: cs.zIndex === 'auto' ? 'auto' : cs.zIndex,
            });
            placeSibling(el, ring, r.left - grow + ox, r.top - grow + oy);
            replaced = true;
        }
        if (replaced) setStyle(el, { 'box-shadow': 'none' });
    }

    // 8. Form fields: dom-to-svg draws neither values nor placeholders. Blank the native value and
    //    put a text twin (same box, font, padding, alignment) right after the field.
    const restores = [];
    let caretPos = null;
    for (const el of document.querySelectorAll('input, textarea, select')) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (el.tagName === 'INPUT' && ![
            'text',
            'search',
            'email',
            'url',
            'password',
            'number',
            'tel',
            '',
        ].includes(type)) continue;
        if (!isVisible(el) || effectiveOpacity(el) < 0.05 || el.getAttribute('aria-hidden') === 'true') continue;
        if (el.readOnly && el.tabIndex === -1) continue; // auto-grow sizer clones (Vuetify etc.)
        const isSelect = el.tagName === 'SELECT';
        const isArea = el.tagName === 'TEXTAREA';
        const cs = getComputedStyle(el);
        const text = isSelect ? (el.selectedOptions[0]?.textContent ?? '') : el.value || el.placeholder || '';
        let color = cs.color;
        if (!isSelect && !el.value) {
            // Placeholders are often dimmed with opacity on ::placeholder rather than a lighter colour.
            const ph = getComputedStyle(el, '::placeholder');
            const [
                pr,
                pg,
                pb,
                pa,
            ] = toRgb(ph.color).match(/[\d.]+/g).map(Number);
            color = `rgba(${pr}, ${pg}, ${pb}, ${(pa * (parseFloat(ph.opacity) || 1)).toFixed(3)})`;
        }
        const r = el.getBoundingClientRect();
        const twin = document.createElement('div');
        // clientWidth/Height exclude scrollbars, which narrow the text box of scrollable textareas.
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        const bb = parseFloat(cs.borderBottomWidth) || 0;
        Object.assign(twin.style, {
            width: `${(el.clientWidth || r.width - bl - br) + bl + br}px`,
            height: `${(el.clientHeight || r.height - bt - bb) + bt + bb}px`,
            boxSizing: 'border-box',
            padding: `${isArea ? cs.paddingTop : '0'} ${cs.paddingRight} 0 ${cs.paddingLeft}`,
            borderStyle: 'solid',
            borderColor: 'transparent',
            borderWidth: cs.borderWidth,
            font: cs.font,
            lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing,
            textAlign: !isSelect && !el.value ? getComputedStyle(el, '::placeholder').textAlign || cs.textAlign : cs.textAlign,
            direction: cs.direction,
            color,
            display: isArea ? 'block' : 'flex',
            alignItems: 'center',
            justifyContent: cs.textAlign === 'center' ? 'center' : /right|end/.test(cs.textAlign) ? 'flex-end' : 'flex-start',
            whiteSpace: isArea ? 'pre-wrap' : 'pre',
            overflowWrap: 'break-word',
            overflow: 'hidden',
            zIndex: '1',
        });
        const span = document.createElement('span');
        text.split('\n').forEach((line, n) => {
            if (n > 0) span.append(document.createElement('br'));
            span.append(document.createTextNode(line));
        });
        twin.append(span);
        placeSibling(el, twin, r.left, r.top);
        if (el === document.activeElement && !isSelect) {
            const rects = span.getClientRects();
            const last = rects[rects.length - 1];
            const sr = span.getBoundingClientRect();
            const lineHeight = last ? last.height : sr.height || parseFloat(cs.fontSize) * 1.2;
            const x = el.value && last ? last.right + 1 : sr.left;
            const top = last ? last.top : sr.top;
            caretPos = [
                Math.round(x),
                Math.round(top),
                Math.round(lineHeight),
            ];
        }
        if (!isSelect) {
            restores.push([
                el,
                el.value,
            ]);
            el.value = '';
            setStyle(el, {
                color: 'transparent',
                '-webkit-text-fill-color': 'transparent',
            });
        }
    }

    // 9. Caret inside a contenteditable editor.
    const active = document.activeElement;
    if (!caretPos && active?.isContentEditable) {
        const sel = window.getSelection();
        if (sel?.rangeCount) {
            const range = sel.getRangeAt(0).cloneRange();
            range.collapse(false);
            let rect = range.getClientRects()[0];
            if (!rect) {
                const marker = document.createElement('span');
                marker.textContent = '​';
                range.insertNode(marker);
                rect = marker.getBoundingClientRect();
                marker.remove();
            }
            if (rect) caretPos = [
                Math.round(rect.left),
                Math.round(rect.top),
                Math.round(rect.height),
            ];
        }
    }

    // 10. CSS transforms (incl. individual translate/rotate/scale): capture untransformed, re-apply on the group.
    const transformed = [];
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.transform === 'none' && cs.rotate === 'none' && cs.translate === 'none' && cs.scale === 'none') continue;
        if (cs.transform.startsWith('matrix3d')) continue;
        let mx = new DOMMatrix();
        if (cs.translate !== 'none') {
            const box = el.getBoundingClientRect();
            const bw = el.offsetWidth || box.width;
            const bh = el.offsetHeight || box.height;
            const [
                txs = '0px',
                tys = '0px',
            ] = cs.translate.split(' ');
            const resolve = (v, size) => (v.endsWith('%') ? (parseFloat(v) / 100) * size : parseFloat(v));
            mx = mx.translate(resolve(txs, bw), resolve(tys, bh));
        }
        if (cs.rotate !== 'none') {
            const v = cs.rotate.split(' ').pop();
            const deg = v.endsWith('turn') ? parseFloat(v) * 360 : v.endsWith('rad') ? (parseFloat(v) * 180) / Math.PI : parseFloat(v);
            mx = mx.rotate(deg);
        }
        if (cs.scale !== 'none') {
            const [
                sx,
                sy,
            ] = cs.scale.split(' ').map(parseFloat);
            mx = mx.scale(sx, sy ?? sx);
        }
        if (cs.transform !== 'none') mx = mx.multiply(new DOMMatrix(cs.transform));
        const m = [
            mx.a,
            mx.b,
            mx.c,
            mx.d,
            mx.e,
            mx.f,
        ];
        if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && Math.abs(m[4]) < 0.01 && Math.abs(m[5]) < 0.01) continue;
        const cls = `film-tf-${transformed.length}`;
        el.classList.add(cls);
        transformed.push({
            el,
            cls,
            m,
            origin: cs.transformOrigin.split(' ').map(parseFloat),
        });
    }
    for (const t of transformed) setStyle(t.el, {
        transform: 'none',
        rotate: 'none',
        translate: 'none',
        scale: 'none',
        transition: 'none',
    });
    // Untransformed boxes can lie outside the viewport (a dialog centred with translate(-50%, -50%) moves
    // half its width right); dom-to-svg skips everything outside its capture area, so widen the area to them.
    let areaLeft = 0;
    let areaTop = 0;
    let areaRight = width;
    let areaBottom = height;
    for (const t of transformed) {
        const r = t.el.getBoundingClientRect();
        t.ox = r.left + t.origin[0];
        t.oy = r.top + t.origin[1];
        areaLeft = Math.min(areaLeft, r.left);
        areaTop = Math.min(areaTop, r.top);
        areaRight = Math.max(areaRight, r.right);
        areaBottom = Math.max(areaBottom, r.bottom);
    }

    // 10b. Preserved newlines inside text nodes -> <br> (dom-to-svg squeezes multi-line text nodes into one line).
    const nlUndo = [];
    const nlWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nlNodes = [];
    while (nlWalker.nextNode()) {
        const node = nlWalker.currentNode;
        if (!node.nodeValue.replace(/\n+$/, '').includes('\n')) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest('textarea, script, style, svg')) continue;
        if (!/^pre/.test(getComputedStyle(parent).whiteSpace)) continue;
        nlNodes.push(node);
    }
    for (const node of nlNodes) {
        const parts = [];
        node.nodeValue.split('\n').forEach((line, n) => {
            if (n > 0) parts.push(document.createElement('br'));
            parts.push(document.createTextNode(line));
        });
        node.replaceWith(...parts);
        nlUndo.push([
            node,
            parts,
        ]);
    }

    // 11. Right-to-left runs: isolate as LTR-direction inline-blocks (the renderer still reorders glyphs).
    const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]+(?:[\s\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]*[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]+)*/g;
    const rtlUndo = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const rtlNodes = [];
    while (walker.nextNode()) {
        RTL.lastIndex = 0;
        if (RTL.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement?.closest('textarea, input')) rtlNodes.push(walker.currentNode);
    }
    for (const node of rtlNodes) {
        const text = node.nodeValue;
        const parts = [];
        let last = 0;
        for (const m of text.matchAll(RTL)) {
            parts.push(document.createTextNode(text.slice(last, m.index)));
            const run = document.createElement('span');
            Object.assign(run.style, {
                display: 'inline-block',
                unicodeBidi: 'isolate',
            });
            run.dir = 'ltr';
            run.textContent = m[0];
            parts.push(run);
            last = m.index + m[0].length;
        }
        parts.push(document.createTextNode(text.slice(last)));
        node.replaceWith(...parts);
        rtlUndo.push([
            node,
            parts,
        ]);
    }

    // Capture.
    const {
        documentToSVG,
        inlineResources,
    } = window.__domToSvg;
    const doc = documentToSVG(document, { captureArea: new DOMRect(areaLeft, areaTop, areaRight - areaLeft, areaBottom - areaTop) });
    const root = doc.documentElement;
    for (const t of transformed) {
        t.el.classList.remove(t.cls);
        const g = root.querySelector(`[class~="${t.cls}"]`);
        if (!g) continue;
        const [
            a,
            b,
            c,
            d,
            e,
            f,
        ] = t.m;
        const own = g.getAttribute('transform');
        g.setAttribute('transform', `translate(${t.ox} ${t.oy}) matrix(${a} ${b} ${c} ${d} ${e} ${f}) translate(${-t.ox} ${-t.oy})${own ? ' ' + own : ''}`);
    }
    // dom-to-svg appends some in-flow children after a context's z-index layers; move them in front.
    for (const ctxEl of [
        root,
        ...root.querySelectorAll('[data-stacking-context="true"]'),
    ]) {
        const kids = [...ctxEl.children];
        const boundary = kids.find((k) => /StackLevelZero|PositiveStackLevels/.test(k.dataset?.stackingLayer || ''));
        if (!boundary) continue;
        for (const k of kids.slice(kids.indexOf(boundary) + 1)) {
            if (k.dataset?.stackingLayer || [
                'title',
                'mask',
                'clipPath',
                'defs',
                'style',
            ].includes(k.localName)) continue;
            ctxEl.insertBefore(k, boundary);
        }
    }
    // ...and it never sorts the root context's z-index layers.
    for (const layer of root.querySelectorAll('[data-stacking-layer$="StackLevels"]')) {
        const kids = [...layer.children].sort((a, b) => (parseInt(a.dataset.zIndex, 10) || 0) - (parseInt(b.dataset.zIndex, 10) || 0));
        for (const kid of kids) layer.append(kid);
    }
    for (const node of root.querySelectorAll('[fill], [stroke], [stop-color], [flood-color]')) {
        for (const attr of [
            'fill',
            'stroke',
            'stop-color',
            'flood-color',
        ]) {
            const v = node.getAttribute(attr);
            if (v && /(oklab|oklch|lab|lch|color-mix|color)\(/.test(v)) node.setAttribute(attr, toRgb(v));
        }
    }
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    await inlineResources(root);

    // Undo everything.
    for (const [
        node,
        parts,
    ] of rtlUndo) {
        parts[0].replaceWith(node);
        for (const part of parts.slice(1)) part.remove();
    }
    for (const [
        node,
        parts,
    ] of nlUndo.reverse()) {
        parts[0].replaceWith(node);
        for (const part of parts.slice(1)) part.remove();
    }
    for (const [
        el,
        value,
    ] of restores) el.value = value;
    for (const node of added) node.remove();
    for (const [
        el,
        cls,
    ] of pseudoHosts) el.classList.remove(cls);
    for (const fn of undo.reverse()) fn();

    let svg = new XMLSerializer().serializeToString(root);
    svg = svg
        .replace(/\sid="([^"]+)"/g, ` id="${prefix}$1"`)
        .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
        .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
    const families = [...svg.matchAll(/font-family="([^"]+)"/g)].map((m) => m[1].replace(/&quot;/g, '"'));
    const bg = toRgb(getComputedStyle(document.body).backgroundColor);
    const htmlBg = toRgb(getComputedStyle(document.documentElement).backgroundColor);
    return {
        svg,
        caretPos,
        families,
        height,
        canvasInfo,
        background: bg.endsWith(', 0.000)') ? htmlBg : bg,
    };
};
