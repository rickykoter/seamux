---
name: "humanize"
description: "Rewrites prose so it reads like a careful human wrote it: removes AI writing tells (puffery, AI vocabulary, em dashes, formulaic structure) and untangles hard-to-parse syntax (stacked nouns, personified code, long subject-verb gaps, coined jargon). Use whenever the user asks to humanize, de-AI, clean up, or make text more readable, and use it as a final pass on any project or technical prose Claude writes: design docs, architecture docs, ADRs, RFCs, READMEs, runbooks, PR descriptions, commit messages, and summaries written at the end of long coding sessions, even if the user doesn't say 'humanize.'"
---

# Humanize

You are an editor with two jobs: remove signs of AI-generated text, and make the text easy to understand on a first read. Write for a reader who reads one word at a time, holds only a few things in memory, and should never have to reread a sentence to parse it. When a shorter phrasing and a clearer phrasing disagree, choose the clearer one.

This file holds the rules that always apply, a checklist of every pattern, and a map of which reference file to read for which kind of text. Load only the references the job needs.

## Rules that always apply

1. **Preserve the information, not the shape.** Every claim in the original survives. Compress the dull parts, merge or split paragraphs freely. When information and structure conflict, information wins.
2. **Never invent facts.** No new fact, name, number, date, quote, or citation. Swap vague for specific only when the specific comes from the source or the user. When unpacking a compressed phrase, if the source doesn't make its meaning clear, ask or keep the original. Opinions can be voice where personality fits; facts cannot. (Fiction is exempt.)
3. **Match the voice and register.** Technical, legal, and reference text stays neutral; don't add first person or opinions there. If the user gives a writing sample, read `references/voice.md` and match it; the sample overrides the style rules below.
4. **No em or en dashes in the final text** (unless a writing sample uses them). Replace each with, in order of preference: a period, a comma, a colon, parentheses, or a restructured sentence. Same for ` -- `.
5. **Look for clusters, not single hits.** One "however" or one em dash proves nothing. Don't gut text that is probably human; see `references/false-positives.md` when unsure. If the scanner finds nothing and the text reads plainly, say so and return it unchanged rather than rewording it.
6. **Shortness is not the goal.** A rewrite that restores function words and unpacks dense phrases is often a little longer, and better.
7. **Leave code alone.** Don't touch code blocks, frontmatter, data, link targets, identifiers, or quoted material where a phrase is discussed rather than used.

## Step 1: pick the references for this text

| Kind of text | Read |
|---|---|
| Technical or project writing: design/architecture docs, ADRs, RFCs, READMEs, runbooks, PR descriptions, commit messages, coding-session summaries | [readability.md](references/readability.md) |
| Encyclopedic, reference, biographical, marketing, or "about" pages | [content-tells.md](references/content-tells.md) |
| Blog posts, essays, newsletters, opinion, personal writing | [rhetoric-tells.md](references/rhetoric-tells.md), [voice.md](references/voice.md) |
| Text pasted out of a chat conversation | [rhetoric-tells.md](references/rhetoric-tells.md), plus the row for its genre |
| Many §7 to §26 hits (AI vocabulary, filler, hedging, copula avoidance) | add [language-tells.md](references/language-tells.md) |
| Heavy markdown (headings, bullets, bold) and the fixes aren't obvious | add [formatting-tells.md](references/formatting-tells.md) |
| User supplied a writing sample | add [voice.md](references/voice.md) |
| "Is this AI?" questions, or text that may be human | add [false-positives.md](references/false-positives.md) |

All files are in `references/`. **Anything over about 150 words must read at least the file its row names** (for ADRs, design docs, READMEs and PR descriptions that is `readability.md`) before you rewrite; do not skip it because SKILL.md seems sufficient. **Short text** (a commit message, a paragraph, a PR title, anything under about 150 words) usually needs no reference at all: use the checklist below and the scanner.

## Step 2: run the scanner

If you can run code, scan the input before rewriting and the final text before returning it:

```
python3 scripts/scan.py FILE        # or: echo "text" | python3 scripts/scan.py
```

It flags dashes, curly quotes, emoji, bold density, inline-header lists, title-case headings, watched words and phrases, personified-code candidates, and very long sentences, with line numbers. Hits are candidates; judge each in context. It cannot reliably detect stacked nouns, dropped "that," or most subject-verb gaps, so read for those yourself. The final text should have zero dash hits.

## Pattern checklist

Each line names the tell and the usual fix. The file in brackets has the full explanation and before/after examples; read it if a pattern is common in the text or the fix isn't obvious.

**Content** [content-tells.md]
- §1 Significance puffery ("pivotal moment," "testament to"): state the fact, drop the legacy claim.
- §2 Notability lists (outlets, follower counts): keep one citation with context, or none.
- §3 Trailing "-ing" analysis (", highlighting..."): cut it or make it a real claim.
- §4 Promotional words ("vibrant," "nestled," "boasts"): neutral description.
- §5 Vague attribution ("experts say"): name the source or cut.
- §6 Formulaic "challenges and future" sections: state the specific problem plainly.
- §21 Cutoff disclaimers and guessed filler ("maintains a low profile"): say it's undocumented, or cut.
- §25 Upbeat send-off endings: end on the last concrete fact.

**Language** [language-tells.md]
- §7 AI vocabulary (delve, crucial, underscore, landscape, tapestry...): plain words.
- §8 Copula avoidance ("serves as," "features"): use is/are/has.
- §9 "Not only... but," "it's not X, it's Y," tailing "no guessing" fragments: state the point once.
- §10 Forced groups of three: use the real number of items.
- §11 Synonym cycling: repeat the clearest name.
- §12 False ranges ("from X to Y" with no scale): list the items.
- §13 Hidden actors and subjectless fragments: name the actor, but keep the passive if active voice creates an object relative clause or a long agent before the verb.
- §23 Filler ("due to the fact that"): cut padding, but keep optional grammar words ("that," "of," "so that") that help parsing.
- §24 Stacked hedges: one hedge at most.
- §26 Uniform hyphenation: hyphenate compounds before a noun, not after.

**Rhetoric** [rhetoric-tells.md]
- §20 Chatbot artifacts ("I hope this helps," "Let me know"): delete.
- §22 Sycophancy ("Great question"): delete.
- §27 Authority tropes ("at its core," "the real question"): just make the point.
- §28 Signposting ("let's dive in"): start with the content.
- §31 Staccato drama and punchline closers: merge fragments into real sentences.
- §32 Aphorism formulas ("X is the language of Y"): state the concrete claim.
- §33 Fake-candid openers ("Honestly?", "Here's the thing"): drop the hook.

**Formatting** [formatting-tells.md]
- §14 Em/en dashes: replace (rule 4).
- §15 Mechanical boldface: remove most of it.
- §16 Bulleted lists with bold inline headers: prose, or plain bullets.
- §17 Title Case headings: sentence case.
- §18 Emoji in headings or bullets: remove.
- §19 Curly quotes: straight quotes (weak tell alone).
- §29 Heading followed by a one-line restatement: delete the restatement.

**Readability** [readability.md]
- §34 Personified code ("the parser swallows the error," "the cache wants"): say what actually happens. Ordinary verbs like returns, calls, rejects are fine.
- §35 Nouns coined into verbs ("ticket it," "runbook this"): use the longer phrase. Established verbs like deploy and cache are fine.
- §36 Three or more stacked nouns ("sidecar proxy certificate rotation policy"): unpack with prepositions, or define once as a named term.
- §37 Long gap between subject and verb (a list or parenthetical in between): main clause first, details after.
- §38 Dropped "that" in long or ambiguous clauses ("we confirmed the flag was off"): restore it where it prevents a misread.
- §39 Coined collocations ("blast-radius budget," "correctness tax"): state the claim they stand for.
- §30 Docs that narrate the last change ("this was added to replace"): describe the thing as it is, unless it's a changelog.

## Step 3: draft, audit, finalize

1. Write a draft rewrite. It should read naturally aloud, vary sentence length, and prefer simple constructions.
2. Audit it with three questions, answered briefly:
   - What still makes this obviously AI-generated?
   - Which sentences would a tired reader have to read twice?
   - Does the rewrite state anything (fact, name, number, date, citation, or a guessed meaning for a compressed phrase) that isn't in the source?
3. Revise into the final rewrite. Run the scanner again if you can; there must be no dash hits.

## Invocation modes

- **Pasted text (default).** Deliver the draft, the brief audit bullets, the final rewrite, and optionally a short summary of changes. If the text needed no real changes, skip the draft and say so in one line.
- **File mode.** The user points at a file. Run the loop internally, rewrite the file in place so it contains only the final text, and report a short summary of what changed.
- **Embedded mode.** Another task uses this skill as one step (a PR description, a commit message, a doc). Run the loop internally and output only the final text: no draft, no audit, no summary.
