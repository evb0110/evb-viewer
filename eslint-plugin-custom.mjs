export default {rules: {
    'import-specifier-newline': {
        meta: {
            type: 'layout',
            docs: {
                description: 'Enforce import specifiers to be either all on one line or each on its own line',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const sourceCode = context.sourceCode;

            return {ImportDeclaration(node) {
                const specifiers = node.specifiers.filter(
                    (s) => s.type === 'ImportSpecifier',
                );

                if (specifiers.length < 2) {
                    return;
                }

                const firstSpecifier = specifiers[0];
                const lastSpecifier = specifiers[specifiers.length - 1];
                const openBrace = sourceCode.getTokenBefore(firstSpecifier);
                const closeBrace = sourceCode.getTokenAfter(lastSpecifier);

                const braceOnDifferentLine = openBrace.loc.end.line !== firstSpecifier.loc.start.line ||
                    closeBrace.loc.start.line !== lastSpecifier.loc.end.line;
                const specifiersOnSameLine = firstSpecifier.loc.start.line === lastSpecifier.loc.end.line;

                if (braceOnDifferentLine && specifiersOnSameLine) {
                    context.report({
                        node: firstSpecifier,
                        message: 'Each import specifier should be on its own line when imports span multiple lines',
                        fix(fixer) {
                            const indent = '    ';
                            const specifierTexts = specifiers.map((s) => sourceCode.getText(s));
                            const source = node.source;

                            const formatted =
                                '{\n' +
                                    specifierTexts.map((t) => `${indent}${t},`).join('\n') +
                                    '\n} from ' +
                                    sourceCode.getText(source);

                            return fixer.replaceTextRange(
                                [
                                    openBrace.range[0],
                                    source.range[1],
                                ],
                                formatted,
                            );
                        },
                    });
                    return;
                }

                const isMultiline = firstSpecifier.loc.start.line !== lastSpecifier.loc.end.line;

                if (!isMultiline) {
                    return;
                }

                for (let i = 0; i < specifiers.length - 1; i++) {
                    const current = specifiers[i];
                    const next = specifiers[i + 1];

                    if (current.loc.end.line === next.loc.start.line) {
                        context.report({
                            node: next,
                            message: 'Each import specifier should be on its own line when imports span multiple lines',
                            fix(fixer) {
                                const indent = '    ';
                                const specifierTexts = specifiers.map((s) => sourceCode.getText(s));
                                const source = node.source;

                                const formatted =
                                    '{\n' +
                                        specifierTexts.map((t) => `${indent}${t},`).join('\n') +
                                        '\n} from ' +
                                        sourceCode.getText(source);

                                return fixer.replaceTextRange(
                                    [
                                        openBrace.range[0],
                                        source.range[1],
                                    ],
                                    formatted,
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
