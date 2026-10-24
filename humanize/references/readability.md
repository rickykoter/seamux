# Readability: grammar that slows human readers

Read for all technical and project writing: design and architecture docs, ADRs, RFCs, READMEs, runbooks, PR descriptions, commit messages, and summaries of coding sessions. Part of the humanize skill; the core rules in SKILL.md (preserve information, never invent facts, no em dashes) always apply.

## READABILITY PATTERNS

The patterns in this section are grammatical, not lexical. They are all legal English, and a reader may not notice them as AI tells, but each one is known to slow human reading. AI models use them more than human writers because each one is a shorter way to say something. The fix is usually a few extra words.

These patterns are strongest in technical writing, in chat, and in text written at the end of long multi-turn or agentic sessions; they are weaker in short single-prompt essays. When humanizing project docs, architecture docs, READMEs, PR descriptions, or summaries of coding work, check this section as carefully as the vocabulary sections.

### 34. Personified Code (Inanimate Subjects with Animate Verbs)

**Verbs to watch (with a system, component, or abstract noun as subject):** swallows, eats, bites, hopes, wants, knows, decides, forgets, remembers, promises, lies, fights, complains, insists, trusts, refuses (figuratively), cares, expects (when it means "assumes")
**Problem:** AI text gives code and abstractions the verbs of living things: a parser that "swallows" an error, an edge case that "bites," a docstring that "promises" behavior, a cache that "wants" warm keys. Readers use whether a subject is animate as a cue for how to parse the sentence, so a mismatch forces a small reanalysis. One instance is a figure of speech; a document full of them is tiring and often vague about what actually happens.
**Before:**
> If the token has expired, the middleware swallows the 401 and the client never learns. The retry loop then hopes the upstream recovers, and the queue quietly eats the backlog.
**After:**
> If the token has expired, the middleware catches the 401 and does not pass it to the client. The retry loop keeps retrying until the upstream responds, and the queue holds the backlog in the meantime.

**Not a tell:** Conventional computing verbs are normal human technical English: returns, calls, accepts, rejects, reads, writes, sends, receives, handles, stores, runs, throws, raises, expects (in a type or API sense), owns (in the ownership sense). Leave these alone. Flag only verbs that describe feelings, intentions, eating, or physical struggle.

### 35. Ad Hoc Denominal Verbs (Nouns Turned into Verbs)

**Examples to watch:** "ticket it," "runbook this," "gate it," "papercut every deploy," "doc it," "allowlist the caller," "flag it off," "calendar it," "footnote it," "PR it," "tombstone the row"
**Problem:** Converting a noun into a verb on the fly saves words, but readers have to stop and work out what the new verb means, and research shows the shift in part of speech triggers re-evaluation while parsing. AI text coins these freely.
**Before:**
> We'll ticket the flaky test and gate the migration until someone runbooks the rollback.
**After:**
> We'll file a ticket for the flaky test and hold the migration behind a feature flag until someone writes a runbook for the rollback.

**Not a tell:** Verbs that are fully established in the field and appear in ordinary documentation: deploy, cache, log, email, query, index, version, commit, merge, fork, script, benchmark, timestamp. When unsure, ask whether the verb would appear in the official docs of a mainstream tool. If not, unpack it.

### 36. Stacked Noun Compounds

**Signs to watch:** three or more nouns in a row, where the first ones modify the last: "sidecar proxy certificate rotation policy," "tenant isolation boundary enforcement," "dry-run write prevention," "dotfile backup path handling," "class-time shutdown requirement"
**Problem:** Stacked nouns compress a whole sentence into a phrase. The reader has to work out the bracketing (is it a "rotation policy" for "sidecar proxy certificates," or a "certificate rotation policy" for the "sidecar proxy"?) and often gets it wrong on the first pass. Architecture docs are especially prone to these.
**Before:**
> Fixed tenant isolation boundary enforcement and sidecar proxy certificate rotation policy handling.
**After:**
> Fixed how tenant boundaries are enforced, and fixed how the sidecar proxy applies its certificate rotation policy.

Unpack with prepositions and verbs ("the policy for rotating certificates in the sidecar proxy"). If the compound names a real concept the document uses repeatedly, define it once in plain words, then use the name consistently (see §11 in language-tells.md; don't cycle synonyms for it).

**Not a tell:** Established multi-noun terms of art: "load balancer health check," "garbage collection pause," "database connection pool," "service level objective." If engineers say the phrase out loud as a unit, keep it.

### 37. Long Gaps Between Subject and Verb

**Signs to watch:** a subject followed by a long parenthetical, appositive list, or relative clause before the main verb arrives; dashes or parentheses holding a list between subject and verb; a main verb that appears after the twentieth word
**Problem:** Readers hold the subject in memory until the verb arrives. The longer the gap, the more they have to hold, and the more likely they are to lose track. Humans naturally keep related words close together; AI text often doesn't, because it has no working-memory limit of its own.
**Before:**
> The three ingestion paths (the batch loader, the streaming consumer, and the backfill job, which only runs on demand when an operator triggers it from the admin console) all write through the same validator.
**After:**
> All three ingestion paths write through the same validator: the batch loader, the streaming consumer, and the backfill job. The backfill job runs only when an operator triggers it from the admin console.

Fixes, in rough order of preference: state the main clause first and put the list or qualification after it; split the sentence; move the long modifier to the end. Short material goes first, long material goes last.

### 38. Dropped Optional "That" and Other Clipped Function Words

**Signs to watch:** relative clauses and complement clauses with no "that" ("the events the consumer skips," "we confirmed the flag was off"), especially several in one paragraph; "so" for "so that"; possessives stacked on long nouns ("the staging cluster's primary node's disk")
**Problem:** Human writers include or drop optional words depending on context. They tend to add "that" when the clause that follows is long or unpredictable, because it tells the reader a clause is coming. AI text drops these words almost every time. A missing "that" can make the reader misparse the following noun as an object ("We confirmed the flag..." reads at first like the flag itself was confirmed).
**Before:**
> The events the consumer skips are the ones the producer marks as replays, and we confirmed the schema registry version the producer pins was the one the migration expected.
**After:**
> The events that the consumer skips are the ones that the producer marks as replays. We confirmed that the schema registry version pinned by the producer was the one that the migration expected.

**Don't overcorrect.** Short, predictable clauses read fine without "that" ("the file you edited," "I think it works"). Restore the word when the clause is long, when the noun after the gap could be misread as an object, or when several reduced clauses pile up in one sentence. The same goes for "of" phrases: "the disk on the primary node of the staging cluster" beats a chain of possessives.

### 39. Coined Collocations and Invented Jargon

**Examples to watch:** "blast-radius budget," "correctness tax," "reader-patience budget," "a config cliff," "the happy-path trap," "a gear trap," "a footgun surface"
**Problem:** AI text pairs familiar words in combinations that rarely or never occur in human writing. Each phrase sounds vivid, but the reader has to reconstruct what it means, and in a technical document the meaning is often less precise than a plain statement would be. §32 (rhetoric-tells.md) covers the aphorism shape of this problem ("X is the Y of Z"); this section covers the coined noun phrases.
**Before:**
> Moving auth into the gateway shrinks our blast-radius budget but adds a correctness tax on every route.
**After:**
> Moving auth into the gateway means a single bug can affect more services. It also means every route depends on the gateway's auth checks being correct.

Test: would this phrase appear in ordinary technical writing by people who never used an AI tool? If you can't picture it in a mainstream project's documentation, replace it with the claim it stands for. Established jargon ("blast radius," "footgun," "happy path" on their own) is fine; the tell is the novel compound built on top of it.

## Also for technical docs

### 30. Diff-Anchored Writing
**Problem:** Documentation or comments written as if narrating a change rather than describing the thing as it is. Unless the document is inherently version-scoped (changelogs, release notes, migration guides), it should read coherently without knowing what changed in the last commit.
**Before:**
> This function was added to replace the previous approach of iterating through all items, which caused O(n²) performance.
**After:**
> This function uses a hash map for O(1) lookups, avoiding the O(n²) cost of naive iteration.
