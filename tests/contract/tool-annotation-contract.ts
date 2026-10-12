import type { AgentTool } from "../../src/tool-types";

/** Framework-neutral host gate: every registered domain tool declares its policy. */
export function assertToolAnnotationContract(tools:readonly AgentTool[]):void {
  const names=new Set<string>();
  for(const tool of tools){
    if(!tool.name||names.has(tool.name))throw new Error("Tool annotation contract: missing or duplicate tool name");
    names.add(tool.name);
    const annotations=tool.annotations;
    if(!annotations)throw new Error(`Tool annotation contract: ${tool.name} has no annotations`);
    for(const key of ["readOnly","destructive","idempotent","requiresApproval"] as const){
      if(typeof annotations[key]!=="boolean")throw new Error(`Tool annotation contract: ${tool.name}.${key} must be explicit`);
    }
    if(annotations.executionMode!=="serial"&&annotations.executionMode!=="parallel")throw new Error(`Tool annotation contract: ${tool.name}.executionMode is missing`);
    if(!annotations.readOnly&&annotations.executionMode==="parallel")throw new Error(`Tool annotation contract: ${tool.name} cannot schedule a write in parallel`);
    if(annotations.readOnly&&annotations.destructive)throw new Error(`Tool annotation contract: ${tool.name} cannot be both read-only and destructive`);
  }
}
