export default {rules: {
    'import-specifier-newline': {
        meta: {
            type: 'layout',
            docs: {
                description: 'Enforce import specifiers to be on separate lines when there are 2 or more',
                recommended: true,
            },
            fixable: 'code',
            schema: [{
                type: 'object',
                properties: {minSpecifiers: {
                    type: 'integer',
                    minimum: 1,
                }},
                additionalProperties: false,
            }],
        },
        create(context) {
            const sourceCode = context.sourceCode;
            const options = context.options[0] || {};
            const minSpecifiers = options.minSpecifiers ?? 2;

            function formatImport(specifiers, openBrace, source) {
                const indent = '    ';
                const specifierTexts = specifiers.map((s) => sourceCode.getText(s));

                return '{\n' +
                    specifierTexts.map((t) => `${indent}${t},`).join('\n') +
                    '\n} from ' +
                    sourceCode.getText(source);
            }

            return {ImportDeclaration(node) {
                const specifiers = node.specifiers.filter(
                    (s) => s.type === 'ImportSpecifier',
                );

                if (specifiers.length < minSpecifiers) {
                    return;
                }

                const firstSpecifier = specifiers[0];
                const openBrace = sourceCode.getTokenBefore(firstSpecifier);

                const allOnSameLine = specifiers.every(
                    (s) => s.loc.start.line === firstSpecifier.loc.start.line,
                );

                if (allOnSameLine) {
                    context.report({
                        node: firstSpecifier,
                        message: `Import specifiers should be on separate lines when there are ${minSpecifiers} or more`,
                        fix(fixer) {
                            return fixer.replaceTextRange(
                                [
                                    openBrace.range[0],
                                    node.source.range[1],
                                ],
                                formatImport(specifiers, openBrace, node.source),
                            );
                        },
                    });
                    return;
                }

                for (let i = 0; i < specifiers.length - 1; i++) {
                    const current = specifiers[i];
                    const next = specifiers[i + 1];

                    if (current.loc.end.line === next.loc.start.line) {
                        context.report({
                            node: next,
                            message: 'Each import specifier should be on its own line',
                            fix(fixer) {
                                return fixer.replaceTextRange(
                                    [
                                        openBrace.range[0],
                                        node.source.range[1],
                                    ],
                                    formatImport(specifiers, openBrace, node.source),
                                );
                            },
                        });
                        break;
                    }
                }
            }};
        },
    },
    'destructuring-property-newline': {
        meta: {
            type: 'layout',
            docs: {
                description: 'Enforce destructuring properties to be on separate lines when there are 2 or more',
                recommended: true,
            },
            fixable: 'code',
            schema: [{
                type: 'object',
                properties: {minProperties: {
                    type: 'integer',
                    minimum: 1,
                }},
                additionalProperties: false,
            }],
        },
        create(context) {
            const sourceCode = context.sourceCode;
            const options = context.options[0] || {};
            const minProperties = options.minProperties ?? 2;

            function getBaseIndent(node) {
                const line = sourceCode.lines[node.loc.start.line - 1];
                const match = line.match(/^(\s*)/);
                return match ? match[1] : '';
            }

            function formatDestructuring(properties, openBrace, closeBrace, baseIndent) {
                const indent = baseIndent + '    ';
                const propertyTexts = properties.map((p) => sourceCode.getText(p));

                return '{\n' +
                    propertyTexts.map((t) => `${indent}${t},`).join('\n') +
                    `\n${baseIndent}}`;
            }

            return {ObjectPattern(node) {
                const properties = node.properties;

                if (properties.length < minProperties) {
                    return;
                }

                const firstProperty = properties[0];
                const openBrace = sourceCode.getFirstToken(node);
                const closeBrace = sourceCode.getLastToken(node);

                const allOnSameLine = properties.every(
                    (p) => p.loc.start.line === firstProperty.loc.start.line,
                );

                const baseIndent = getBaseIndent(node);

                if (allOnSameLine) {
                    context.report({
                        node: firstProperty,
                        message: `Destructuring properties should be on separate lines when there are ${minProperties} or more`,
                        fix(fixer) {
                            return fixer.replaceTextRange(
                                [
                                    openBrace.range[0],
                                    closeBrace.range[1],
                                ],
                                formatDestructuring(properties, openBrace, closeBrace, baseIndent),
                            );
                        },
                    });
                    return;
                }

                for (let i = 0; i < properties.length - 1; i++) {
                    const current = properties[i];
                    const next = properties[i + 1];

                    if (current.loc.end.line === next.loc.start.line) {
                        context.report({
                            node: next,
                            message: 'Each destructuring property should be on its own line',
                            fix(fixer) {
                                return fixer.replaceTextRange(
                                    [
                                        openBrace.range[0],
                                        closeBrace.range[1],
                                    ],
                                    formatDestructuring(properties, openBrace, closeBrace, baseIndent),
                                );
                            },
                        });
                        break;
                    }
                }
            }};
        },
    },
    'vue-boolean-prop-shorthand': {
        meta: {
            type: 'suggestion',
            docs: {
                description:
                        'Enforce boolean prop shorthand in Vue templates (e.g., is-draggable instead of :is-draggable="true")',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const parserServices =
                context.parserServices ||
                    context.sourceCode?.parserServices;

            if (
                !parserServices ||
                    !parserServices.defineTemplateBodyVisitor
            ) {
                return {};
            }

            function getAttributeName(node) {
                if (!node.directive) {
                    return node.key.rawName;
                }

                if (
                    (node.key.name.name === 'bind' ||
                            node.key.name.name === 'model') &&
                        node.key.argument &&
                        node.key.argument.type === 'VIdentifier'
                ) {
                    return node.key.argument.rawName;
                }

                return null;
            }

            function shouldConvertToShortForm(node) {
                const isLiteralTrue =
                    node.directive &&
                        node.value?.expression?.type === 'Literal' &&
                        node.value.expression.value === true &&
                        Boolean(node.key.argument);

                return isLiteralTrue;
            }

            return parserServices.defineTemplateBodyVisitor({VAttribute(node) {
                const name = getAttributeName(node);
                if (name === null) {
                    return;
                }

                if (shouldConvertToShortForm(node)) {
                    const directiveKey = node.key;
                    if (
                        directiveKey.argument &&
                                directiveKey.argument.type === 'VIdentifier'
                    ) {
                        context.report({
                            node,
                            message: `Use shorthand '${directiveKey.argument.rawName}' instead of ':${directiveKey.argument.rawName}="true"'`,
                            fix(fixer) {
                                return fixer.replaceText(
                                    node,
                                    directiveKey.argument.rawName,
                                );
                            },
                        });
                    }
                }
            }});
        },
    },
    'brace-return-after-if': {
        meta: {
            type: 'layout',
            docs: {
                description:
                        'Require braces around return statements after if conditions',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const sourceCode = context.sourceCode;

            return {IfStatement(node) {
                if (
                    node.consequent.type === 'ReturnStatement' ||
                            (node.consequent.type === 'BlockStatement' &&
                                node.consequent.body.length === 1 &&
                                node.consequent.body[0].type ===
                                    'ReturnStatement' &&
                                sourceCode.getText(node.consequent).split('\n')
                                    .length < 3)
                ) {
                    if (node.consequent.type === 'ReturnStatement') {
                        context.report({
                            node: node.consequent,
                            message:
                                        'Return statement after if condition must be wrapped in braces on 3 lines',
                            fix(fixer) {
                                const returnStmt = sourceCode.getText(
                                    node.consequent,
                                );
                                const indent = ' '.repeat(
                                    node.consequent.loc.start.column,
                                );
                                const innerIndent = indent + '    ';
                                const replacement = `{\n${innerIndent}${returnStmt}\n${indent}}`;
                                return fixer.replaceText(
                                    node.consequent,
                                    replacement,
                                );
                            },
                        });
                    } else if (
                        node.consequent.type === 'BlockStatement' &&
                                node.consequent.body.length === 1 &&
                                node.consequent.body[0].type ===
                                    'ReturnStatement'
                    ) {
                        const blockText = sourceCode.getText(
                            node.consequent,
                        );
                        const lines = blockText.split('\n');

                        if (lines.length < 3) {
                            context.report({
                                node: node.consequent,
                                message:
                                            'Return statement in braces after if condition must occupy exactly 3 lines',
                                fix(fixer) {
                                    const returnStmt =
                                        sourceCode.getText(
                                            node.consequent.body[0],
                                        );
                                    const indent = ' '.repeat(
                                        node.consequent.loc.start
                                            .column,
                                    );
                                    const innerIndent = indent + '    ';
                                    const replacement = `{\n${innerIndent}${returnStmt}\n${indent}}`;
                                    return fixer.replaceText(
                                        node.consequent,
                                        replacement,
                                    );
                                },
                            });
                        }
                    }
                }
            }};
        },
    },
    'no-scss-ampersand-concatenation': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Disallow SCSS ampersand concatenation (&- pattern) which is not CSS-compatible',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            const parserServices = context.parserServices || context.sourceCode?.parserServices;

            if (!parserServices || !parserServices.defineDocumentVisitor) {
                return {};
            }

            return parserServices.defineDocumentVisitor({'VElement[name="style"]'(node) {
                if (!node.children || node.children.length === 0) {
                    return;
                }

                const styleContent = node.children
                    .filter(child => child.type === 'VText')
                    .map(child => ({
                        text: child.value,
                        loc: child.loc,
                    }));

                for (const {
                    text,
                    loc,
                } of styleContent) {
                    const lines = text.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const regex = /&-+(?![^{]*\{[^}]*:[^}]*\})/g;
                        let match;

                        while ((match = regex.exec(line)) !== null) {
                            const column = match.index;
                            context.report({
                                message: `Avoid SCSS ampersand concatenation '${match[0]}'. Use explicit class selectors instead (e.g., '.block--modifier' instead of '&--modifier')`,
                                loc: {
                                    start: {
                                        line: loc.start.line + i,
                                        column: i === 0 ? loc.start.column + column : column,
                                    },
                                    end: {
                                        line: loc.start.line + i,
                                        column: i === 0 ? loc.start.column + column + match[0].length : column + match[0].length,
                                    },
                                },
                            });
                        }
                    }
                }
            }});
        },
    },
    'nuxt-ui-semantic-utilities': {
        meta: {
            type: 'suggestion',
            docs: {
                description: 'Prefer Nuxt UI semantic utility classes over raw CSS variable utilities',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const parserServices = context.parserServices || context.sourceCode?.parserServices;

            if (!parserServices || !parserServices.defineTemplateBodyVisitor) {
                return {};
            }

            const sourceCode = context.getSourceCode();
            const replacements = [
                [
                    'text-(--ui-text-dimmed)',
                    'text-dimmed',
                ],
                [
                    'text-(--ui-text-muted)',
                    'text-muted',
                ],
                [
                    'text-(--ui-text-toned)',
                    'text-toned',
                ],
                [
                    'text-(--ui-text)',
                    'text-default',
                ],
                [
                    'text-(--ui-text-highlighted)',
                    'text-highlighted',
                ],
                [
                    'text-(--ui-text-inverted)',
                    'text-inverted',
                ],
                [
                    'bg-(--ui-bg)',
                    'bg-default',
                ],
                [
                    'bg-(--ui-bg-muted)',
                    'bg-muted',
                ],
                [
                    'bg-(--ui-bg-elevated)',
                    'bg-elevated',
                ],
                [
                    'bg-(--ui-bg-accented)',
                    'bg-accented',
                ],
                [
                    'bg-(--ui-bg-inverted)',
                    'bg-inverted',
                ],
                [
                    'border-(--ui-border)',
                    'border-default',
                ],
                [
                    'border-(--ui-border-muted)',
                    'border-muted',
                ],
                [
                    'border-(--ui-border-accented)',
                    'border-accented',
                ],
                [
                    'border-(--ui-border-inverted)',
                    'border-inverted',
                ],
            ];

            function replaceTokens(value) {
                let next = value;
                const matches = [];

                for (const [
                    from,
                    to,
                ] of replacements) {
                    if (next.includes(from)) {
                        next = next.split(from).join(to);
                        matches.push([
                            from,
                            to,
                        ]);
                    }
                }

                if (matches.length === 0) {
                    return null;
                }

                return {
                    value: next,
                    matches,
                };
            }

            function escapeForQuote(value, quote) {
                const escapedBackslash = value.replace(/\\/g, '\\\\');
                if (quote === '`') {
                    return escapedBackslash.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
                }
                return escapedBackslash.replace(new RegExp(quote, 'g'), `\\${quote}`);
            }

            function reportLiteral(node, rawValue, result) {
                if (!result) {
                    return;
                }

                const message = result.matches
                    .map(([
                        from,
                        to,
                    ]) => `'${from}' -> '${to}'`)
                    .join(', ');

                context.report({
                    node,
                    message: `Use Nuxt UI semantic utilities: ${message}`,
                    fix(fixer) {
                        const raw = sourceCode.getText(node);
                        const quote = raw[0];
                        const escaped = escapeForQuote(result.value, quote);

                        if (quote === '`') {
                            return fixer.replaceText(node, `\`${escaped}\``);
                        }
                        if (quote === '"' || quote === '\'') {
                            return fixer.replaceText(node, `${quote}${escaped}${quote}`);
                        }
                        return null;
                    },
                });
            }

            function getLiteralValue(node) {
                if (!node) {
                    return null;
                }
                if (node.type === 'VLiteral') {
                    return node.value;
                }
                if (node.type === 'Literal' && typeof node.value === 'string') {
                    return node.value;
                }
                if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
                    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
                }
                return null;
            }

            function walkExpression(node, visitor, seen) {
                if (!node || typeof node !== 'object') {
                    return;
                }
                if (seen.has(node)) {
                    return;
                }
                seen.add(node);

                visitor(node);

                if (node.type === 'ObjectExpression') {
                    for (const prop of node.properties || []) {
                        if (prop && prop.key && prop.key.type === 'Literal' && typeof prop.key.value === 'string' && !prop.computed) {
                            visitor(prop.key);
                        }
                    }
                }

                for (const key of Object.keys(node)) {
                    if (key === 'parent') {
                        continue;
                    }
                    const value = node[key];
                    if (Array.isArray(value)) {
                        for (const child of value) {
                            walkExpression(child, visitor, seen);
                        }
                    } else if (value && typeof value === 'object' && value.type) {
                        walkExpression(value, visitor, seen);
                    }
                }
            }

            return parserServices.defineTemplateBodyVisitor({VAttribute(node) {
                const isClass =
                    !node.directive
                    && node.key?.type === 'VIdentifier'
                    && node.key.name === 'class';

                const isBoundClass =
                    node.directive
                    && node.key?.name?.name === 'bind'
                    && node.key.argument
                    && node.key.argument.type === 'VIdentifier'
                    && node.key.argument.name === 'class';

                if (isClass) {
                    const literalValue = getLiteralValue(node.value);
                    if (literalValue) {
                        const result = replaceTokens(literalValue);
                        reportLiteral(node.value, literalValue, result);
                    }
                    return;
                }

                if (isBoundClass && node.value && node.value.expression) {
                    const seen = new Set();
                    walkExpression(
                        node.value.expression,
                        (child) => {
                            const literalValue = getLiteralValue(child);
                            if (!literalValue) {
                                return;
                            }
                            const result = replaceTokens(literalValue);
                            reportLiteral(child, literalValue, result);
                        },
                        seen,
                    );
                }
            }});
        },
    },
    'tailwind-class-shorthand': {
        meta: {
            type: 'suggestion',
            docs: {
                description: 'Suggest Tailwind class shorthands and remove duplicates',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const parserServices = context.parserServices || context.sourceCode?.parserServices;

            if (!parserServices || !parserServices.defineTemplateBodyVisitor) {
                return {};
            }

            const sourceCode = context.getSourceCode();

            const ops = [
                {
                    a: 'pt',
                    b: 'pb',
                    short: 'py',
                },
                {
                    a: 'pl',
                    b: 'pr',
                    short: 'px',
                },
                {
                    a: 'mt',
                    b: 'mb',
                    short: 'my',
                },
                {
                    a: 'ml',
                    b: 'mr',
                    short: 'mx',
                },
                {
                    a: 'px',
                    b: 'py',
                    short: 'p',
                },
                {
                    a: 'mx',
                    b: 'my',
                    short: 'm',
                },
                {
                    a: 'gap-x',
                    b: 'gap-y',
                    short: 'gap',
                },
                {
                    a: 'space-x',
                    b: 'space-y',
                    short: 'space',
                },
                {
                    a: 'border-t',
                    b: 'border-b',
                    short: 'border-y',
                },
                {
                    a: 'border-l',
                    b: 'border-r',
                    short: 'border-x',
                },
                {
                    a: 'border-x',
                    b: 'border-y',
                    short: 'border',
                },
            ];

            function getLiteralValue(node) {
                if (!node) {
                    return null;
                }
                if (node.type === 'VLiteral') {
                    return node.value;
                }
                if (node.type === 'Literal' && typeof node.value === 'string') {
                    return node.value;
                }
                if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
                    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
                }
                return null;
            }

            function escapeForQuote(value, quote) {
                const escapedBackslash = value.replace(/\\/g, '\\\\');
                if (quote === '`') {
                    return escapedBackslash.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
                }
                return escapedBackslash.replace(new RegExp(quote, 'g'), `\\${quote}`);
            }

            const names = [
                'pt',
                'pb',
                'pl',
                'pr',
                'mt',
                'mb',
                'ml',
                'mr',
                'px',
                'py',
                'mx',
                'my',
                'p',
                'm',
                'gap-x',
                'gap-y',
                'gap',
                'space-x',
                'space-y',
                'space',
                'border-t',
                'border-b',
                'border-l',
                'border-r',
                'border-x',
                'border-y',
                'border',
            ];

            const spacingUtilities = new Set([
                'p',
                'px',
                'py',
                'pt',
                'pb',
                'pl',
                'pr',
                'm',
                'mx',
                'my',
                'mt',
                'mb',
                'ml',
                'mr',
                'gap',
                'gap-x',
                'gap-y',
                'space-x',
                'space-y',
                'space',
                'w',
                'h',
                'min-w',
                'max-w',
                'min-h',
                'max-h',
                'inset',
                'inset-x',
                'inset-y',
                'top',
                'right',
                'bottom',
                'left',
                'translate-x',
                'translate-y',
            ]);

            const borderWidthMap = new Map([
                [
                    0,
                    '0',
                ],
                [
                    1,
                    '',
                ],
                [
                    2,
                    '2',
                ],
                [
                    4,
                    '4',
                ],
                [
                    8,
                    '8',
                ],
            ]);

            function parseArbitraryToken(token) {
                const parts = token.split(':');
                let base = parts.pop();
                const prefix = parts.join(':');

                if (!base) {
                    return null;
                }

                let negative = false;
                if (base.startsWith('-')) {
                    negative = true;
                    base = base.slice(1);
                }

                const match = base.match(/^([a-z-]+)-\[(.+)\]$/);
                if (!match) {
                    return null;
                }

                return {
                    token,
                    prefix,
                    name: match[1],
                    negative,
                    value: match[2],
                };
            }

            function parseNumericValue(value) {
                if (!value) {
                    return null;
                }

                let nextValue = value.trim();
                let negative = false;

                if (nextValue.startsWith('-')) {
                    negative = true;
                    nextValue = nextValue.slice(1);
                }

                const match = nextValue.match(/^([0-9]*\.?[0-9]+)(px|rem)?$/);
                if (!match) {
                    return null;
                }

                return {
                    number: Number(match[1]),
                    unit: match[2] ?? null,
                    negative,
                };
            }

            function formatScale(value) {
                const rounded = Math.round(value * 1000) / 1000;
                const text = String(rounded);
                if (!text.includes('.')) {
                    return text;
                }
                return text.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
            }

            function convertSpacingValue(value) {
                const parsed = parseNumericValue(value);
                if (!parsed) {
                    return null;
                }

                const multiplier = parsed.unit === 'rem'
                    ? 4
                    : parsed.unit === 'px'
                        ? 1 / 4
                        : null;

                if (!multiplier) {
                    return null;
                }

                const scale = parsed.number * multiplier;
                return {
                    scale: formatScale(scale),
                    negative: parsed.negative,
                };
            }

            function convertBorderWidth(value) {
                const parsed = parseNumericValue(value);
                if (!parsed || parsed.unit === 'rem') {
                    return null;
                }

                const pxValue = parsed.unit === 'px' || parsed.unit === null
                    ? parsed.number
                    : null;

                if (pxValue === null) {
                    return null;
                }

                if (!borderWidthMap.has(pxValue)) {
                    return null;
                }

                return {
                    suffix: borderWidthMap.get(pxValue),
                    negative: parsed.negative,
                };
            }

            function convertArbitraryTokens(tokens) {
                const replacements = [];
                const next = tokens.map((token) => {
                    const parsed = parseArbitraryToken(token);
                    if (!parsed) {
                        return token;
                    }

                    if (spacingUtilities.has(parsed.name)) {
                        const converted = convertSpacingValue(parsed.value);
                        if (!converted) {
                            return token;
                        }

                        const negative = parsed.negative || converted.negative;
                        const replacement = buildToken(
                            parsed.prefix,
                            negative,
                            parsed.name,
                            converted.scale,
                        );
                        replacements.push(`'${token}' -> '${replacement}'`);
                        return replacement;
                    }

                    if (parsed.name.startsWith('border')) {
                        const converted = convertBorderWidth(parsed.value);
                        if (!converted) {
                            return token;
                        }

                        const replacement = buildToken(
                            parsed.prefix,
                            parsed.negative || converted.negative,
                            parsed.name,
                            converted.suffix || null,
                        );
                        replacements.push(`'${token}' -> '${replacement}'`);
                        return replacement;
                    }

                    return token;
                });

                return {
                    tokens: next,
                    replacements,
                };
            }

            function parseToken(token) {
                const parts = token.split(':');
                const base = parts.pop();
                const prefix = parts.join(':');

                if (!base) {
                    return null;
                }

                for (const name of names) {
                    if (base === name) {
                        return {
                            token,
                            prefix,
                            name,
                            negative: false,
                            value: null,
                        };
                    }

                    const regex = new RegExp(`^(-)?${name}-(.+)$`);
                    const match = base.match(regex);
                    if (match) {
                        return {
                            token,
                            prefix,
                            name,
                            negative: match[1] === '-',
                            value: match[2],
                        };
                    }
                }

                return null;
            }

            function buildToken(prefix, negative, name, value) {
                const base = value === null
                    ? `${negative ? '-' : ''}${name}`
                    : `${negative ? '-' : ''}${name}-${value}`;
                return prefix ? `${prefix}:${base}` : base;
            }

            function applyShorthands(tokens) {
                let next = [...tokens];
                const replacements = [];

                let changed = true;
                while (changed) {
                    changed = false;
                    const details = next
                        .map((token, index) => {
                            const parsed = parseToken(token);
                            return parsed ? {
                                ...parsed,
                                index,
                            } : null;
                        })
                        .filter(Boolean);

                    for (const op of ops) {
                        const match = details.find((item) =>
                            item.name === op.a
                            && details.some((candidate) =>
                                candidate.name === op.b
                                && candidate.prefix === item.prefix
                                && candidate.value === item.value
                                && candidate.negative === item.negative,
                            ),
                        );

                        if (!match) {
                            continue;
                        }

                        const counterpart = details.find((candidate) =>
                            candidate.name === op.b
                            && candidate.prefix === match.prefix
                            && candidate.value === match.value
                            && candidate.negative === match.negative,
                        );

                        if (!counterpart) {
                            continue;
                        }

                        const shorthand = buildToken(match.prefix, match.negative, op.short, match.value);
                        const insertIndex = Math.min(match.index, counterpart.index);
                        const removeIndex = Math.max(match.index, counterpart.index);

                        next[insertIndex] = shorthand;
                        next.splice(removeIndex, 1);

                        replacements.push(`'${match.token}' + '${counterpart.token}' -> '${shorthand}'`);
                        changed = true;
                        break;
                    }
                }

                return {
                    tokens: next,
                    replacements,
                };
            }

            function dedupeTokens(tokens) {
                const seen = new Set();
                const deduped = [];
                const duplicates = [];

                for (const token of tokens) {
                    if (seen.has(token)) {
                        duplicates.push(`'${token}'`);
                        continue;
                    }
                    seen.add(token);
                    deduped.push(token);
                }

                return {
                    tokens: deduped,
                    duplicates,
                };
            }

            function isBorderSizeValue(value) {
                if (value === null) {
                    return true;
                }
                if (value === 'px') {
                    return true;
                }
                if (/^\d+(\.\d+)?$/.test(value)) {
                    return true;
                }
                if (value.startsWith('[') && value.endsWith(']')) {
                    return /(\d|px|rem|em|%)\b/.test(value);
                }
                return false;
            }

            function findConflicts(tokens) {
                const seen = new Map();
                const conflicts = [];

                for (const token of tokens) {
                    const parsed = parseToken(token);
                    if (!parsed) {
                        continue;
                    }

                    if (parsed.name.startsWith('border') && !isBorderSizeValue(parsed.value)) {
                        continue;
                    }

                    const key = `${parsed.prefix}|${parsed.name}|${parsed.negative}`;
                    const valueKey = parsed.value === null ? 'DEFAULT' : parsed.value;

                    if (seen.has(key)) {
                        const existing = seen.get(key);
                        if (existing.value !== valueKey) {
                            conflicts.push({
                                name: parsed.name,
                                prefix: parsed.prefix,
                                values: [
                                    existing.value,
                                    valueKey,
                                ],
                                tokens: [
                                    existing.token,
                                    token,
                                ],
                            });
                        }
                        continue;
                    }

                    seen.set(key, {
                        value: valueKey,
                        token,
                    });
                }

                return conflicts;
            }

            function simplifyClassString(value) {
                const tokens = value.trim().split(/\s+/).filter(Boolean);
                const arbitrary = convertArbitraryTokens(tokens);
                const shorthand = applyShorthands(arbitrary.tokens);
                const deduped = dedupeTokens(shorthand.tokens);
                const conflicts = findConflicts(arbitrary.tokens);
                const replacements = [
                    ...arbitrary.replacements,
                    ...shorthand.replacements,
                ];
                const changed = replacements.length > 0 || deduped.duplicates.length > 0;

                if (!changed && conflicts.length === 0) {
                    return null;
                }

                return {
                    value: deduped.tokens.join(' '),
                    replacements,
                    duplicates: deduped.duplicates,
                    conflicts,
                };
            }

            function reportLiteral(node, rawValue, result) {
                if (!result) {
                    return;
                }

                const parts = [];
                if (result.replacements.length > 0) {
                    parts.push(result.replacements.join(', '));
                }
                if (result.duplicates.length > 0) {
                    parts.push(`remove duplicates: ${result.duplicates.join(', ')}`);
                }

                if (parts.length > 0) {
                    const message = parts.join('; ');

                    context.report({
                        node,
                        message,
                        fix(fixer) {
                            const raw = sourceCode.getText(node);
                            const quote = raw[0];
                            const escaped = escapeForQuote(result.value, quote);

                            if (quote === '`') {
                                return fixer.replaceText(node, `\`${escaped}\``);
                            }
                            if (quote === '"' || quote === '\'') {
                                return fixer.replaceText(node, `${quote}${escaped}${quote}`);
                            }
                            return null;
                        },
                    });
                }

                if (result.conflicts && result.conflicts.length > 0) {
                    const conflictMessages = result.conflicts.map((conflict) => {
                        const label = conflict.prefix
                            ? `${conflict.prefix}:${conflict.name}`
                            : conflict.name;
                        return `${label} -> ${conflict.tokens.join(' vs ')}`;
                    });

                    context.report({
                        node,
                        message: `Conflicting Tailwind utilities: ${conflictMessages.join('; ')}`,
                    });
                }
            }

            function walkExpression(node, visitor, seen) {
                if (!node || typeof node !== 'object') {
                    return;
                }
                if (seen.has(node)) {
                    return;
                }
                seen.add(node);

                visitor(node);

                if (node.type === 'ObjectExpression') {
                    for (const prop of node.properties || []) {
                        if (prop && prop.key && prop.key.type === 'Literal' && typeof prop.key.value === 'string' && !prop.computed) {
                            visitor(prop.key);
                        }
                    }
                }

                for (const key of Object.keys(node)) {
                    if (key === 'parent') {
                        continue;
                    }
                    const value = node[key];
                    if (Array.isArray(value)) {
                        for (const child of value) {
                            walkExpression(child, visitor, seen);
                        }
                    } else if (value && typeof value === 'object' && value.type) {
                        walkExpression(value, visitor, seen);
                    }
                }
            }

            return parserServices.defineTemplateBodyVisitor({VAttribute(node) {
                const isClass =
                    !node.directive
                    && node.key?.type === 'VIdentifier'
                    && node.key.name === 'class';

                const isBoundClass =
                    node.directive
                    && node.key?.name?.name === 'bind'
                    && node.key.argument
                    && node.key.argument.type === 'VIdentifier'
                    && node.key.argument.name === 'class';

                if (isClass) {
                    const literalValue = getLiteralValue(node.value);
                    if (literalValue) {
                        const result = simplifyClassString(literalValue);
                        reportLiteral(node.value, literalValue, result);
                    }
                    return;
                }

                if (isBoundClass && node.value && node.value.expression) {
                    const seen = new Set();
                    walkExpression(
                        node.value.expression,
                        (child) => {
                            const literalValue = getLiteralValue(child);
                            if (!literalValue) {
                                return;
                            }
                            const result = simplifyClassString(literalValue);
                            reportLiteral(child, literalValue, result);
                        },
                        seen,
                    );
                }
            }});
        },
    },
}};
