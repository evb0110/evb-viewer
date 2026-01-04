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
}};
