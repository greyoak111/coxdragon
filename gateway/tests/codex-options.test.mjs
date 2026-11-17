import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../gw/config.mjs';
import { OPTION_DEFAULTS, codexOptions, saveCodexOptions, validateCodexOptions, codexOverrides, codexOptionArgs, publicEffectiveOptions } from '../gw/codex-options.mjs';
import { _codexForTest as cx } from '../gw/codex.mjs';
if(process.platform==='win32'&&!process.getuid)process.getuid=()=>0;
const file=path.join(CFG.home,'coxdragon-codex-options.json');
function reset(){cx.stopServer();for(const key of ['runningTurns','startingTurns','operations','loadedThreads','threadCwds','approvals','compacting'])cx.S[key].clear();cx.S.starting=null;cx.S.activeTurn=null;saveCodexOptions(OPTION_DEFAULTS);}
after(()=>cx.stopServer());

test('Codex 选项：严格校验、合并保存、原子写失败保持旧值',()=>{
 reset();saveCodexOptions({developer_instructions:'line one\n"quoted" \\ path',model_verbosity:'high'});
 assert.equal(codexOptions().model_verbosity,'high');assert.equal(JSON.parse(fs.readFileSync(file)).developer_instructions,codexOptions().developer_instructions);
 for(const value of [null,[],{unknown:true},{web_search:'invalid'},{model_reasoning_summary:'full'},{model_verbosity:2},{model_auto_compact_token_limit:12},{model_auto_compact_token_limit:1024.1},{developer_instructions:'x'.repeat(16001)},{compact_prompt:'\0'}])assert.throws(()=>validateCodexOptions(value),error=>error.statusCode===400);
 const prior=fs.readFileSync(file);fs.rmSync(file);fs.mkdirSync(file);
 try{assert.throws(()=>saveCodexOptions({model_verbosity:'low'}),/没有保存/);assert.equal(codexOptions().model_verbosity,'high');}finally{fs.rmdirSync(file);fs.writeFileSync(file,prior);}
 const copy=codexOptions();copy.model_verbosity='low';assert.equal(codexOptions().model_verbosity,'high');
});

test('Codex 选项：空值继承，Chat 强制关闭托管搜索，安全显示有效配置',()=>{
 reset();assert.deepEqual(codexOverrides(),{});saveCodexOptions({web_search:'live',compact_prompt:'summarize\n"code"'});
 assert.equal(codexOverrides({mode:'custom',wireApi:'chat'}).web_search,'disabled');assert.equal(codexOverrides({mode:'custom',wireApi:'responses'}).web_search,'live');
 assert(codexOptionArgs({mode:'custom',wireApi:'chat'}).includes('compact_prompt="summarize\\n\\"code\\""'));
 const visible=publicEffectiveOptions({web_search:'cached',api_key:'synthetic-secret',model_providers:{secret:true}});
 assert.equal(visible.web_search,'cached');assert.equal(visible.model_verbosity,null);assert(!JSON.stringify(visible).includes('secret'));
});

test('Codex 选项：忙时拒绝修改，空闲保存重启且保留聊天引用',()=>{
 reset();cx.S.activeThread={id:'preserved'};cx.S.runningTurns.set('b',{id:'busy'});
 assert.throws(()=>cx.updateEngineOptions({model_verbosity:'low'}),error=>error.statusCode===409);assert.equal(codexOptions().model_verbosity,'');
 cx.S.runningTurns.clear();cx.S.starting=Promise.resolve();assert.throws(()=>cx.updateEngineOptions({web_search:'live'}),error=>error.statusCode===409);cx.S.starting=null;
 const result=cx.updateEngineOptions({model_verbosity:'low'});assert.equal(result.engineOptions.model_verbosity,'low');assert.equal(cx.S.rpc,null);assert.equal(cx.S.activeThread.id,'preserved');
});

test('Codex 选项：新建、恢复和思考摘要传给引擎，检查配置仅返回白名单',async()=>{
 reset();saveCodexOptions({web_search:'cached',developer_instructions:'test instruction',model_reasoning_summary:'concise',model_auto_compact_token_limit:48000});
 const calls=[];cx.S.rpc={stderr:'',request:async(method,params)=>{calls.push({method,params});if(method==='config/read')return {config:{web_search:'cached',api_key:'must-not-expose'}};return method==='turn/start'?{turn:{id:'t',status:'completed'}}:{thread:{id:'options-thread',cwd:CFG.workspace,turns:[]}};}};
 await cx.startThread(CFG.workspace);assert.equal(calls.at(-1).params.config.developer_instructions,'test instruction');
 cx.S.loadedThreads.clear();await cx.resumeThread('options-thread');assert.equal(calls.findLast(c=>c.method==='thread/resume').params.config.model_auto_compact_token_limit,48000);
 await cx.startTurn('test','options-thread');assert.equal(calls.at(-1).params.summary,'concise');
 const result=await cx.inspectEngineOptions(CFG.workspace);assert.equal(result.options.web_search,'cached');assert(!JSON.stringify(result).includes('must-not-expose'));assert.equal(calls.at(-1).params.includeLayers,false);
 reset();
});

test('Codex 选项：清空摘要覆盖后按当前项目配置发送，读取失败不启动轮次',async()=>{
 reset();cx.S.activeThread={id:'inherit',cwd:CFG.workspace};cx.S.loadedThreads.add('inherit');cx.S.threadCwds.set('inherit',CFG.workspace);
 const calls=[];cx.S.rpc={stderr:'',request:async(method,params)=>{calls.push({method,params});return method==='config/read'?{config:{model_reasoning_summary:'none'}}:{turn:{id:'inherit-turn',status:'completed'}};}};
 await cx.startTurn('test','inherit');assert.equal(calls.at(-1).params.summary,'none');assert.equal(calls[0].params.cwd,CFG.workspace);
 cx.S.rpc.request=async()=>{throw new Error('Synthetic config read failed');};await assert.rejects(cx.startTurn('test','inherit'),/config read failed/);assert.equal(cx.S.startingTurns.size,0);
 reset();
});
