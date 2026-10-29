# humanize: prose that reads like a person wrote it

Part of [seamux](../README.md). Install and setup are in the [main README](../README.md#setup).

humanize is an editing skill. Ask Claude to "humanize" a draft, or let it run
as the last pass on a design doc, ADR, README, PR description or commit
message. It keeps every claim in the original, adds none, removes the
marks of machine-written text (puffery, stock vocabulary, em dashes,
formulaic structure), and rewrites sentences a reader would have to parse
twice. Text that already reads plainly comes back unchanged.

deep-plan runs it over the prose in a spec before rendering, and lookout runs
it over the replies it writes to you and tells its reviewer to write findings
in plain verbs. `humanize/scripts/scan.py` finds the mechanical tells (dashes,
curly quotes, emoji, bold density, watched words, long sentences) with line
numbers. It only flags candidates, and the model decides which ones matter.

The readability rules (`humanize/references/readability.md`, patterns 34 to
39) follow Clark, Martin and Mahowald, who compared nine language models with
human writing and found that the models use more inanimate subjects with
animate verbs and more low-frequency n-grams, and most use longer dependencies
and more stacked nouns:

> Thomas Hikaru Clark, Matias B. Martin and Kyle Mahowald. *Why is
> AI-generated language so hard to understand?* arXiv:2610.29162, October
> 2026. <https://arxiv.org/abs/2610.29162>

Those rules cover personified code, stacked noun compounds, long gaps between
subject and verb, and coined jargon. The paper's conclusion (section 6) is
that models trained for code and math face different pressures than human
language does, so their output can be grammatical and still hard to read.
The other patterns in the skill (content, language, rhetoric and formatting
tells) are not taken from the paper.
