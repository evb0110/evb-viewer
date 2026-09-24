// A textual scan for runtime code construction in the built worker bundles.
// Code assembled at runtime escapes the bundle graph, so the static integrity
// checks cannot see what a worker would actually execute.
//
// Scope, precisely: this recognizes call sites written as `eval(`, `Function(`,
// `new Function(`, the indirect `(0, eval)` form, and the same three reached
// through an explicit `globalThis.`/`window.`/`self.` prefix. It is a regular
// expression over bundle text, not a parser: aliased references
// (`const f = Function; f(src)`), computed member access (`globalThis["eval"]`),
// and any other indirection are out of reach, and only the bundles the caller
// passes in are examined. It is a tripwire for the obvious spellings, not a
// proof that a bundle constructs no code.
//
// `eval` and `new Function` are forbidden outright — no worker bundle contains
// either today. Bare `Function(...)` cannot be forbidden outright, because two
// vendored dependency idioms use it; those two forms are allowlisted here with
// their justification, so any *new* runtime code construction still fails.

const DYNAMIC_CODE_CALL_SITE_PATTERN
    = /\(\s*0\s*,\s*eval\s*\)|(?<![.\w$])(?:new\s+)?(?:(?:globalThis|window|self)\.)?(?:Function|eval)\s*\(/gu;

const CALL_SITE_SHAPE = /^(new\s+)?((?:globalThis|window|self)\.)?(Function|eval)/u;

const EXCERPT_LENGTH = 80;

// Anchored at the call site, so an idiom only excuses the exact vendored form.
const ALLOWED_VENDOR_IDIOMS = [
    {
        justification: 'core-js/whatwg globalThis polyfill',
        pattern: /^Function\((["'])return this\1\)\(\)/u,
    },
    {
        // Reached only on Node builds without `process.getBuiltinModule`, and
        // wrapped in a swallowing try/catch by the dependency.
        justification: 'core-js Node built-in module fallback',
        pattern: /^Function\('return require\("'\s*\+\s*[\w$]+\s*\+\s*'"\)'\)\(\)/u,
    },
];

/** @param {string} matchText */
function classifyCallSite(matchText) {
    if (matchText.startsWith('(')) {
        return 'indirect (0, eval)';
    }
    const [
        ,
        constructor,
        globalPrefix,
        name,
    ] = CALL_SITE_SHAPE.exec(matchText) ?? [];
    return `${constructor ? 'new ' : ''}${globalPrefix ?? ''}${name}(`;
}

/**
 * Classifies the bare `eval`/`Function` construction call sites this policy can
 * see in a worker bundle's text (see the scope note at the top of this file).
 *
 * `violations` are the sites this policy forbids. `allowedIdioms` names the
 * vendored idioms actually present, so a stale allowlist entry is visible
 * instead of silently granting permission.
 *
 * @param {string} content bundle source text
 * @returns {{allowedIdioms: string[], violations: Array<{excerpt: string, kind: string}>}}
 */
export function analyzeDynamicCodeConstruction(content) {
    const allowedIdioms = new Set();
    const violations = [];

    for (const match of content.matchAll(DYNAMIC_CODE_CALL_SITE_PATTERN)) {
        const callSite = content.slice(match.index, match.index + EXCERPT_LENGTH);
        const kind = classifyCallSite(match[0]);
        const allowed = kind === 'Function('
            && ALLOWED_VENDOR_IDIOMS.find(({pattern}) => pattern.test(callSite));

        if (allowed) {
            allowedIdioms.add(allowed.justification);
            continue;
        }

        violations.push({
            excerpt: callSite,
            kind,
        });
    }

    return {
        allowedIdioms: [...allowedIdioms],
        violations,
    };
}
