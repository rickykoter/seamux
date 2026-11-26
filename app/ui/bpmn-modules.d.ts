// The two bpmn.io packages bpmnlayout.ts uses ship no types: the parts it calls.

declare module "bpmn-moddle" {
  export class BpmnModdle {
    fromXML(xml: string): Promise<{ rootElement: unknown; warnings: unknown[] }>;
    toXML(root: unknown): Promise<{ xml: string }>;
  }
}

declare module "bpmn-auto-layout" {
  export function layoutProcess(xml: string): Promise<string>;
}
