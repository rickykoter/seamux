// A BPMN file that carries no diagram gets one laid out here. Flowable and
// Activiti run a process from its XML alone, so a .bpmn20.xml written by
// hand or by code usually has no BPMNDiagram section, and bpmn-js has no
// shapes to draw. bpmn-auto-layout (pinned in package.json) places every
// step and sequence flow. The app imports this on first need. Lookout
// carries the same file, bundled by `npm run vendor:lookout`, as the global
// SeamuxBpmnLayout.

import { BpmnModdle } from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";

/** Whether `xml` places any shape. Without one bpmn-js draws an empty page. */
export function hasDiagram(xml: string): boolean {
  return /<(?:[\w.-]+:)?BPMNShape[\s/>]/.test(xml);
}

type El = {
  $type: string;
  id?: string;
  name?: string;
  flowElements?: El[];
  sourceRef?: El;
  targetRef?: El;
  incoming?: El[];
  outgoing?: El[];
};

/** Each step's incoming and outgoing flows, filled in from the flows'
 *  sourceRef and targetRef. The layout follows those lists, and Flowable
 *  never writes them, so without this every step lands with no arrows. A
 *  step with no name is labelled with its id: a process written in code
 *  names its steps by id alone, and blank boxes say nothing. */
function link(container: El): void {
  for (const el of container.flowElements ?? []) {
    if (el.$type === "bpmn:SequenceFlow") {
      const s = el.sourceRef;
      const t = el.targetRef;
      if (s && !(s.outgoing ??= []).includes(el)) s.outgoing.push(el);
      if (t && !(t.incoming ??= []).includes(el)) t.incoming.push(el);
    } else if (!el.name && el.id) {
      el.name = el.id;
    }
    if (el.flowElements) link(el);
  }
}

/** `xml` as bpmn-js should draw it: unchanged when it has a diagram (unless
 *  `force`, which lookout uses to compare two sides in one form), and
 *  with one laid out when it has none (`laidOut` says which), its unnamed
 *  steps labelled by id. Flowable's own attributes and extension elements
 *  stay as they are. */
export async function withDiagram(xml: string, force = false): Promise<{ xml: string; laidOut: boolean; processes: number }> {
  if (!force && hasDiagram(xml)) return { xml, laidOut: false, processes: 0 };
  const moddle = new BpmnModdle();
  const { rootElement } = (await moddle.fromXML(xml)) as { rootElement: { rootElements?: El[] } };
  const processes = (rootElement.rootElements ?? []).filter((r) => r.$type === "bpmn:Process");
  for (const p of processes) link(p);
  const { xml: linked } = await moddle.toXML(rootElement);
  // bpmn-auto-layout lays out the first process only: `processes` lets the
  // caller say the others are not drawn.
  return { xml: await layoutProcess(linked), laidOut: true, processes: processes.length };
}

/** What a laid-out diagram's note says: who placed the boxes, and which
 *  processes are missing. The app and lookout both show it. */
export function layoutNote(by: string, processes: number): string {
  const more = processes > 1 ? ` Only the first of its ${processes} processes is drawn.` : "";
  return `Laid out by ${by}: this file stores no diagram positions. Unnamed steps show their ids.${more}`;
}
