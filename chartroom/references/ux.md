# UX options: a ux chart

Read this before writing the panes of a `ux` chart.

A ux chart puts two to four whole alternatives side by side on the studio's
tabs, so the person can flip between them with the keys 1 to 4 and pick one.
It works when the options really differ. Three shades of one layout give the
person nothing to choose between.

## Choosing the options

- **Vary one big thing per option**: the layout, the order of steps, what is
  shown first, how much is on one screen. Name each option by that thing
  ("Single column", "Two columns", "Summary first"), not "A" or "Option 2".
- **Two to four.** One is not a choice; five is a menu nobody reads.
- **Each option is complete.** The same content, the same states, the same
  fidelity. A rough option beside a polished one loses on polish alone.
- **Say the trade-off** in the version note (`--note`): what each option is
  good at and what it costs. The person reads it in the studio's Notes rail.

## Writing a pane

Start from `chartroom template ux <file>`. Keep what it sets up:

- The product's real words, prices, names and lengths. Long names and empty
  lists are part of the design.
- The hard states where they matter: an error on a field, an empty list,
  a loading row. Show them in the pane rather than describing them.
- `id`s on the things people will talk about (`id="pay"`, `id="total"`), kept
  the same across options and versions, so a pin follows its element.
- Tokens in `:root` for colour, radius and spacing. If the repo has a design
  system (a tokens file, a theme, components), use its values.
- No network: inline CSS and SVG only. Icons as inline SVG, never emoji.
- One screen per pane. A flow of several screens is several views of an
  `arch`-style sequence, or one pane that stacks the steps vertically.
- Say what width the screen is for with `<meta name="chartroom-width"
  content="1100">` (390 for a phone screen). In a narrow pane or on a phone
  the studio renders the pane at that width and scales it to fit, so a
  desktop design keeps its layout; without the tag it assumes 1100.

## After a comment

Answer in the thread, then add a new version with every option, the changed
ones and the unchanged ones, so the flip (hold Space) compares like with
like. Keep the option keys and labels stable across versions. When the
person's comment applies to every option, change every option.

## After the pick

The chart is `chosen` and its decision names the option. Build from the
chosen pane: its structure, tokens and words. If later work changes the
design enough that the chart no longer shows it, add a version so the chart
stays the record, or set it `superseded` when a new chart replaces it.
