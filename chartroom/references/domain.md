# Domain explorers: a domain chart

Read this before writing a `domain` chart.

A domain chart maps the words a team uses: what each one means, where that
meaning comes from, and how the words relate. It is for joining a codebase,
a new problem space, or an argument about what a word means.

## Gathering the terms

- **Start from the code's nouns**: model and table names, types, enum values,
  event names. Then the docs, tickets and anything the person tells you.
- **Use the team's own word** as the term, and list other names under `aka`
  (what support says, what the old code says, what the API calls it).
- **Every term cites a source**: a `path:line`, a doc, a ticket, a person.
  A definition you inferred and could not check is `"unverified": true` and
  shows so. Never present a guess as a definition.
- **The disagreements are the finding.** Where the code and the people use a
  word differently, say so in the definition, plainly.
- **Twelve to forty terms.** Fewer and it is a paragraph; more and it needs
  splitting into charts by area.

## Writing the chart

Start from `chartroom template domain <file>`. Fill the `DOMAIN` block; the
page renders the searchable glossary and the relation map from it.

- A definition is one or two sentences a newcomer understands without the
  code open.
- `related` lists the terms a reader needs next, not every term that shares
  a table.
- One sentence of purpose in the header: the area, who uses the words, and
  the question the chart should help answer.

A domain chart usually has one view. Add a second view (an entity diagram, a
state machine for one term) when a relation needs drawing, not listing.

## After a comment

People correct definitions in comments. Answer with the source you checked,
fix the term, and add a new version. When a correction comes from a person
rather than the code, keep `unverified` until a source agrees, and cite the
person.
