import { expect, test } from "bun:test";
import type { AgentTool, AgentToolAnnotations } from "../../src/tool-types";
import { assertToolAnnotationContract } from "./tool-annotation-contract";

const annotations:AgentToolAnnotations={readOnly:true,destructive:false,idempotent:true,requiresApproval:false,executionMode:"parallel"};
const tool=(policy:AgentToolAnnotations|undefined):AgentTool=>({name:"inspect",description:"inspect",parameters:{type:"object",properties:{}},annotations:policy,execute:async()=>({success:true,message:"inspected"})});

test("host contract rejects missing or contradictory policy annotations",()=>{
  for(const key of ["readOnly","destructive","idempotent","requiresApproval","executionMode"] as const){
    const partial={...annotations};delete partial[key];
    expect(()=>assertToolAnnotationContract([tool(partial)])).toThrow();
  }
  expect(()=>assertToolAnnotationContract([tool(undefined)])).toThrow();
  expect(()=>assertToolAnnotationContract([tool({...annotations,readOnly:false})])).toThrow();
  expect(()=>assertToolAnnotationContract([tool({...annotations,destructive:true})])).toThrow();
  expect(()=>assertToolAnnotationContract([tool(annotations),tool(annotations)])).toThrow();
});

test("host contract validates complete read and edit policies without executing tools",()=>{
  let effects=0;
  const tools:AgentTool[]=[{...tool(annotations),execute:async()=>{effects++;return{success:true,message:"inspected"};}},
    {...tool({readOnly:false,destructive:false,idempotent:false,requiresApproval:false,executionMode:"serial"}),name:"trim"}];
  assertToolAnnotationContract(tools);
  expect(effects).toBe(0);
});
