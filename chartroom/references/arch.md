# Architecture views: an arch chart

Read this before writing the views of an `arch` chart.

An arch chart is a set of views of one system, each answering one question.
The person reads them on the studio's tabs and pins comments on a box or an
arrow. Nothing is picked: views are not options.

## Which views

Choose the views the question needs, usually two or three:

| view | answers | draw |
|---|---|---|
| context | who and what is outside, and what crosses the edge | the system as one box, people and outside systems around it |
| containers | what runs, and what talks to what | services, stores, workers, queues, with the protocol on each arrow |
| sequence | what happens, in order, for one case | lanes per part, numbered steps, the failure branch |
| data flow | where a piece of data goes and who can see it | stores and transforms, with what is kept where |

A view that tries to answer two questions answers neither: split it.

## Writing a view

Start from `chartroom template arch <file>`. It draws boxes and arrows as
inline SVG from the `DIAGRAM` block; edit the data, not the drawing code.

- **Read before you draw.** Every box and arrow comes from code, config or a
  doc you read this session. What you inferred and could not check gets
  `"unverified": true` and draws dashed. Never draw a guess as solid.
- **Name things the way the code does.** The person will look for the box
  named after the folder or service they know.
- **Every arrow says what crosses it**: a call and its verb, an event and its
  name, a file, a query. Say sync or async when it matters.
- **Mark the change.** In a chart about a change, `"status": "new"` and
  `"status": "changed"` show what the change adds and alters.
- **One sentence of purpose** per view, in its header: what it answers, for
  whom, and what it leaves out.

For a sequence, lay the parts out as columns and the steps as rows, or
replace the drawing code with a lane layout; keep the same rules.

## After a comment

Answer in the thread with what you checked. When the comment shows the
drawing was wrong, fix the data and add a new version of every view it
touches. Keep node ids stable so pins follow.
