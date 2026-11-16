import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { readThreadUsage, normalizeTokenUsage } from "../gw/codex-context.mjs";

test("上下文恢复：最近请求、累计计费和压缩后的失效状态分别保留", async()=>{
  const root=path.join(CFG.home,"history-fixture");await fs.mkdir(root,{recursive:true});
  const file=path.join(root,"session.jsonl"),header={type:"session_meta",payload:{id:"history",model_provider:"openai"}};
  const usage={timestamp:"2026-11-17T00:00:00Z",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:200,output_tokens:10,total_tokens:210},total_token_usage:{input_tokens:1000,output_tokens:50,total_tokens:1050,cached_input_tokens:800},model_context_window:64000}}};
  const write=rows=>fs.writeFile(file,rows.map(v=>JSON.stringify(v)).join("\n")+"\n");
  await write([header,{type:"turn_context",payload:{model:"fixture"}},usage]);
  let result=await readThreadUsage(file,root,"history");
  assert.equal(result.last.totalTokens,210);assert.equal(result.total.totalTokens,1050);assert.equal(result.total.cachedInputTokens,800);
  assert.equal(result.last.cachedInputTokens,null);assert.equal(result.model,"fixture");assert.equal(result.source,"history");assert.equal(result.modelContextWindow,64000);
  await write([header,usage,{type:"compacted",payload:{}}]);assert.equal((await readThreadUsage(file,root,"history")).stale,true);
  await write([header,usage,{type:"compacted",payload:{}},usage]);assert.equal((await readThreadUsage(file,root,"history")).stale,false);
  assert.equal(normalizeTokenUsage({inputTokens:10,outputTokens:5}).totalTokens,15);
  assert.equal(normalizeTokenUsage({inputTokens:10}),null);
  assert.equal(normalizeTokenUsage({totalTokens:15,cachedInputTokens:-1}).cachedInputTokens,null);
});

test("上下文恢复：大文件只读尾部，校验会话身份并限制到引擎记录目录",async()=>{
  const root=path.join(CFG.home,"large-history");await fs.mkdir(root,{recursive:true});const file=path.join(root,"large.jsonl");
  await fs.writeFile(file,JSON.stringify({type:"session_meta",payload:{id:"large"}})+"\n"+"x".repeat(5<<20)+"\n"+JSON.stringify({type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{total_tokens:42}}}})+"\n");
  assert.equal((await readThreadUsage(file,root,"large")).last.totalTokens,42);
  assert.equal(await readThreadUsage(file,root,"other"),null);
  assert.equal(await readThreadUsage(file,path.join(root,"missing"),"large"),null);
  const outside=path.join(CFG.home,"outside.jsonl");await fs.copyFile(file,outside);assert.equal(await readThreadUsage(outside,root,"large"),null);
});
