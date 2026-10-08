"""deep-plan families on the board: members sit together, ordered as one.

A family is a parent plan and the child plans its `workstreams` block names
(deep-plan/lib/family.mjs). `deep-plan status --json` puts `family` on each
member's row; rank() copies the parent's slug and the member's role onto the
board row, and group() here does the rest:

  - every member of a family moves as one unit, placed where its most urgent
    member would sort on its own -- a child that needs you pulls its parent
    and siblings up with it;
  - inside the unit the parent leads, then the children by their own tier;
  - a quiet member joins its family rather than the quiet list, so a family is
    read together; a family whose members are ALL quiet stays in the quiet
    section, still grouped;
  - a family whose parent has no row is headed by a label instead.

Pure: rows in, rows out. With no family on the board, both lists come back
as they went in, so a machine without families renders byte-identically.

    python3 families.py < {"rows": [...], "quiet": [...]}   -> the same, grouped
"""
import json
import sys

TIER = {"attend": 0, "wilt": 1, "running": 2, "done": 3, "quiet": 4}
NAME = {v: k for k, v in TIER.items()}


def group(rows, quiet):
    everything = list(rows) + list(quiet)
    if not any(r.get("family") for r in everything):
        return rows, quiet
    pos = {id(r): i for i, r in enumerate(everything)}

    def own(r):
        # A row's own sort key, as rank() orders it: tier, then urgency, then
        # gather order (sort stability made explicit).
        return (TIER.get(r.get("kind"), 9), -float(r.get("urgency") or 0.0), pos[id(r)])

    fams = {}
    for r in everything:
        if r.get("family"):
            fams.setdefault(r["family"], []).append(r)

    units = []
    for r in rows:
        if not r.get("family"):
            units.append((own(r), [r]))
    for fam, members in fams.items():
        lead = min(own(r) for r in members)
        ordered = sorted(members, key=lambda r: (r.get("famrole") != "parent",) + own(r))
        for r in ordered:
            r["famtier"] = NAME.get(lead[0], "quiet")
            r["famkid"] = r.get("famrole") == "child"
        if ordered[0].get("famrole") != "parent":
            ordered[0]["famlabel"] = fam
        units.append((lead, ordered))
    for r in quiet:
        if not r.get("family"):
            units.append((own(r), [r]))

    units.sort(key=lambda u: u[0])
    out_rows, out_quiet = [], []
    for key, members in units:
        (out_quiet if key[0] == TIER["quiet"] else out_rows).extend(members)
    return out_rows, out_quiet


if __name__ == "__main__":
    data = json.load(sys.stdin)
    r, q = group(data.get("rows", []), data.get("quiet", []))
    json.dump({"rows": r, "quiet": q}, sys.stdout)
