export function resolveFixturePages(fixture) {
    if (Array.isArray(fixture.pages)) {
        if (fixture.pages.length === 0 || fixture.pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
            throw new Error(`Invalid pages for fixture "${String(fixture.id)}"`);
        }
        return [...fixture.pages];
    }
    const range = fixture.pageRange;
    if (
        range === null ||
        typeof range !== 'object' ||
        !Number.isSafeInteger(range.from) ||
        !Number.isSafeInteger(range.to) ||
        range.from < 1 ||
        range.to < range.from
    ) {
        throw new Error(`Invalid pageRange for fixture "${String(fixture.id)}"`);
    }
    return Array.from({length: range.to - range.from + 1}, (_, index) => range.from + index);
}

function normalizedSpan(start, end, total) {
    const normalizedStart = start / total;
    const normalizedEnd = end / total;
    let normalizedLength = normalizedEnd - normalizedStart;
    // When a non-zero start and its complementary width are serialized as two
    // decimals, another IEEE-754 parser can round their sum one ULP above 1.
    // Keep edge-touching boxes microscopically inside the normalized domain so
    // the strict native manifest validator sees the same bounded rectangle.
    if (normalizedStart > 0 && normalizedEnd === 1) {
        normalizedLength = Math.max(Number.EPSILON, normalizedLength - Number.EPSILON * 4);
    }
    return {
        length: normalizedLength,
        start: normalizedStart,
    };
}

export function reusablePagePlan(analysis, previewOutputs, analysisDimensions) {
    const rotationDegrees = analysis.rotationDegrees;
    const analysisWidth = rotationDegrees === 90 || rotationDegrees === 270 ? analysisDimensions.height : analysisDimensions.width;
    const splitXNormalized = Number.isFinite(analysis.cutterXPx) && analysisWidth > 0 ? analysis.cutterXPx / analysisWidth : null;
    const automaticSplit =
        splitXNormalized !== null && splitXNormalized > 0 && splitXNormalized < 1
            ? {
                  rotationDegrees,
                  xNormalized: splitXNormalized,
              }
            : undefined;
    const automaticContentBoxes = Object.fromEntries(
        previewOutputs.flatMap((output) => {
            const box = output.contentBox;
            const outputRotation = output.rotationDegrees ?? rotationDegrees;
            const fullWidth = outputRotation === 90 || outputRotation === 270 ? output.inputHeightPx : output.inputWidthPx;
            const fullHeight = outputRotation === 90 || outputRotation === 270 ? output.inputWidthPx : output.inputHeightPx;
            const source = output.sourceRegion;
            if (box === null || fullWidth <= 0 || fullHeight <= 0 || source.widthPx <= 0 || source.heightPx <= 0) {
                return [];
            }
            const left = Math.max(0, Math.min(source.widthPx, box.xPx));
            const top = Math.max(0, Math.min(source.heightPx, box.yPx));
            const right = Math.max(left, Math.min(source.widthPx, box.xPx + box.widthPx));
            const bottom = Math.max(top, Math.min(source.heightPx, box.yPx + box.heightPx));
            if (right <= left || bottom <= top) {
                return [];
            }
            const horizontal = normalizedSpan(left, right, fullWidth);
            const vertical = normalizedSpan(top, bottom, fullHeight);
            return [
                [
                    output.half,
                    {
                        heightNormalized: vertical.length,
                        rotationDegrees: outputRotation,
                        widthNormalized: horizontal.length,
                        xNormalized: horizontal.start,
                        yNormalized: vertical.start,
                    },
                ],
            ];
        }),
    );
    const automaticSkewDegrees = Object.fromEntries(
        previewOutputs.flatMap((output) =>
            output.manualSkew !== true && output.skewApplied === true && Number.isFinite(output.detectedSkewDegrees)
                ? [[output.half, output.detectedSkewDegrees]]
                : [],
        ),
    );
    const resolvedTextToneDiagnostics = Object.fromEntries(
        previewOutputs.flatMap((output) => (output.textToneDiagnostics === undefined ? [] : [[output.half, output.textToneDiagnostics]])),
    );
    const layout =
        analysis.layoutClassification === 'single-uncut-page'
            ? 'force-single'
            : analysis.layoutClassification === 'two-page-spread' && automaticSplit !== undefined
              ? 'force-two-page'
              : analysis.layoutClassification === 'page-with-offcut' && automaticSplit !== undefined
                ? 'page-with-offcut'
                : 'auto';
    return {
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        ...(Object.keys(automaticContentBoxes).length === 0 ? {} : {automaticContentBoxes}),
        ...(Object.keys(automaticSkewDegrees).length === 0 ? {} : {automaticSkewDegrees}),
        ...(Object.keys(resolvedTextToneDiagnostics).length === 0 ? {} : {resolvedTextToneDiagnostics}),
        layout,
    };
}

function normalizedContentBox(output) {
    const box = output.contentBox;
    const rotationDegrees = output.rotationDegrees ?? 0;
    const fullWidth = rotationDegrees === 90 || rotationDegrees === 270 ? output.inputHeightPx : output.inputWidthPx;
    const fullHeight = rotationDegrees === 90 || rotationDegrees === 270 ? output.inputWidthPx : output.inputHeightPx;
    const source = output.sourceRegion;
    if (box === null || fullWidth <= 0 || fullHeight <= 0 || source.widthPx <= 0 || source.heightPx <= 0) {
        return null;
    }
    const left = Math.max(0, Math.min(source.widthPx, box.xPx));
    const top = Math.max(0, Math.min(source.heightPx, box.yPx));
    const right = Math.max(left, Math.min(source.widthPx, box.xPx + box.widthPx));
    const bottom = Math.max(top, Math.min(source.heightPx, box.yPx + box.heightPx));
    if (right <= left || bottom <= top) {
        return null;
    }
    return {
        height: (bottom - top) / fullHeight,
        width: (right - left) / fullWidth,
        x: left / fullWidth,
        y: top / fullHeight,
    };
}

function normalizedFinalPixelTolerance(output, key) {
    const rotationDegrees = output.rotationDegrees ?? 0;
    const fullWidth = rotationDegrees === 90 || rotationDegrees === 270 ? output.inputHeightPx : output.inputWidthPx;
    const fullHeight = rotationDegrees === 90 || rotationDegrees === 270 ? output.inputWidthPx : output.inputHeightPx;
    const axisPixels = key === 'x' || key === 'width' ? fullWidth : fullHeight;
    // A canonical normalized boundary can land between pixels when replayed at
    // final resolution. The native renderer must choose the nearest raster
    // boundary, so at most half a final pixel is representable. Keep the
    // allowance tied to that final pixel grid: a genuine one-pixel plan shift
    // still fails.
    return 0.5 / Math.max(1, axisPixels) + Number.EPSILON * 16;
}

export function pagePlanParityFailures(analysis, previewOutputs, outputMetadata) {
    const failures = [];
    const previewOutput = previewOutputs.find((output) => output.half === outputMetadata.half);
    if (previewOutput === undefined) {
        return [`missing preview output for ${outputMetadata.half}`];
    }
    const paleCollapseGrayscaleFallback =
        analysis.recommendedOutputMode === 'bw' &&
        outputMetadata.outputMode === 'grayscale' &&
        Array.isArray(outputMetadata.warnings) &&
        outputMetadata.warnings.some(
            (warning) =>
                typeof warning === 'string' &&
                /^Black-and-white rendering left source page \d+ \((?:full page|left half|right half)\) empty although the leaf carries structure; the grayscale rendition was emitted instead$/.test(
                    warning,
                ),
        );
    if (outputMetadata.outputMode !== analysis.recommendedOutputMode && !paleCollapseGrayscaleFallback) {
        failures.push(`mode ${String(outputMetadata.outputMode)} != ${String(analysis.recommendedOutputMode)}`);
    }
    const expectedTone = previewOutput.textToneDiagnostics;
    const actualTone = outputMetadata.textToneDiagnostics;
    if (
        expectedTone !== undefined &&
        (actualTone === undefined ||
            actualTone.applied !== expectedTone.applied ||
            actualTone.rule !== expectedTone.rule ||
            actualTone.inkAnchor !== expectedTone.inkAnchor)
    ) {
        failures.push(
            `text tone ${JSON.stringify(actualTone)} != canonical ${JSON.stringify({
                applied: expectedTone.applied,
                inkAnchor: expectedTone.inkAnchor,
                rule: expectedTone.rule,
            })}`,
        );
    }
    const expectedBox = normalizedContentBox(previewOutput);
    const actualBox = normalizedContentBox(outputMetadata);
    if (
        expectedBox !== null &&
        (actualBox === null ||
            Object.keys(expectedBox).some(
                (key) => Math.abs(expectedBox[key] - actualBox[key]) > normalizedFinalPixelTolerance(outputMetadata, key),
            ))
    ) {
        failures.push(`content box ${JSON.stringify(actualBox)} != canonical ${JSON.stringify(expectedBox)}`);
    }
    if (previewOutput.skewApplied === true && outputMetadata.detectedSkewDegrees !== previewOutput.detectedSkewDegrees) {
        failures.push(`skew ${String(outputMetadata.detectedSkewDegrees)} != canonical ${String(previewOutput.detectedSkewDegrees)}`);
    }
    return failures;
}

function modePreservationRank(analysis) {
    if (analysis.recommendedOutputMode === 'bw') {
        return 0;
    }
    if (analysis.recommendedOutputMode === 'color') {
        return 2;
    }
    if (analysis.recommendedOutputMode === 'mixed' && analysis.outputModeDiagnostics?.significantColor === true) {
        return 2;
    }
    return 1;
}

function hasMaterialPreservationEvidence(analysis) {
    const diagnostics = analysis.outputModeDiagnostics;
    if (diagnostics === null || typeof diagnostics !== 'object') {
        return false;
    }
    return (
        diagnostics.significantColor === true ||
        diagnostics.significantPicture === true ||
        diagnostics.coherentOutsideTonalRegion === true ||
        diagnostics.rule === 'continuous-tone' ||
        diagnostics.rule === 'picture'
    );
}

export function crossResolutionModeEvidence(pageRuns) {
    const unstablePages = pageRuns
        .filter((page) => page.analysis.recommendedOutputMode !== page.finalInputAnalysis.recommendedOutputMode)
        .map(
            (page) =>
                `p${page.pageNumber} ${String(page.analysis.recommendedOutputMode)}` +
                `->${String(page.finalInputAnalysis.recommendedOutputMode)}`,
        );
    const destructivePages = pageRuns
        .filter(
            (page) =>
                modePreservationRank(page.analysis) < modePreservationRank(page.finalInputAnalysis) &&
                hasMaterialPreservationEvidence(page.finalInputAnalysis),
        )
        .map(
            (page) =>
                `p${page.pageNumber} ${String(page.analysis.recommendedOutputMode)}` +
                `->${String(page.finalInputAnalysis.recommendedOutputMode)}`,
        );
    return {
        destructivePages,
        unstablePages,
    };
}
