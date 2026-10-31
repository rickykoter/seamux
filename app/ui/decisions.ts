// The decisions the views feed carries (views.rs's ViewsFrame), shared by the
// Dock and the sheet.
import type { FamilyBrief, FamilyMember } from "./family";
import type { Levels, TuckRow } from "./tuck";

// The shapes of views.rs's ViewsFrame.
export type Opt = { label: string; description: string };
export type Question = { question: string; header: string; multiSelect: boolean; options: Opt[] };
export type Check = { id: string; kind: string; name: string; status: string };
export type Decision =
  | { kind: "question"; ws: string; surface: string; since: number; questions: Question[] }
  | { kind: "asked"; ws: string; surface: string; since: number; question: string }
  | {
      kind: "gate";
      ws: string;
      surface: string;
      since: number;
      slug: string;
      n: number;
      title: string;
      done: number;
      total: number;
      checks: Check[];
      ready: boolean;
    }
  | { kind: "family"; ws: string; surface: string; since: number; parent: string; members: FamilyMember[] }
  | {
      kind: "review";
      ws: string;
      surface: string;
      since: number;
      id: string;
      title: string;
      plan: string;
      inc: number;
      addressed: number;
      open: number;
    };
export type WakeRow = { id: number; kind: string; title: string; dir: string; ws: string | null; at: number };
export type Change = { at: number; ws: string; surface: string; state: string; source: string; detail: string };
export type ViewsFrame = { decisions: Decision[]; wake: WakeRow[]; history: Change[]; problems: string[]; levels?: Levels; tucked?: TuckRow[]; families?: FamilyBrief[] };
