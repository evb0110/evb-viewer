# Latin ligatures without the long s

`missale-1835-urbanus.jpg` is the left column of Urban VIII's bull in
*Missale romanum* (Philadelphia, 1835), a public-domain book digitized by
the University of Toronto and the Internet Archive:
<https://archive.org/details/missaleromanume00cath/page/n9/mode/1up>.

The source is `missaleromanume00cath_jp2.zip`, member
`missaleromanume00cath_jp2/missaleromanume00cath_0009.jp2` (2591×4333).
The crop is `(180, 1505, 1245, 3880)`, converted to grayscale JPEG at quality
95 without resampling. The scan is 400 ppi. The 39 lines in
`missale-1835-urbanus.gt.txt` are transcribed from the crop, retaining case,
punctuation, line-end hyphens, æ and œ. There is no long s.

This fixture exercises #1240: selecting Latin must recognize the printed
ligatures directly, without depending on the early-print reread.
