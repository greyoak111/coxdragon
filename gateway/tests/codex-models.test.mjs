import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { modelDetails, reduceModelCatalog, refreshModelCatalog, rememberApiModels, customModels,saveModelSettings,configuredModel,modelSettings,searchModelCatalog,saveModelSettingsBatch } from "../gw/codex-models.mjs";

const model = { id: "fixture-vision", name: "Fixture Vision", reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  modalities: { input: ["text", "image", "audio"], output: ["text"] }, limit: { context: 128000 } };
const providers = { fixture: { api: "https://fixture.test/v1", models: { "fixture-vision": model } } };

test("模型能力：常用 API 别名和手动覆盖按提供商、模型持久化，可恢复自动声明",async()=>{
  const scope="https://manual-capabilities.test/v1",id="manual-model";
  const metadata=modelDetails({id,input_modalities:["text","image"],output_modalities:["text"],top_provider:{context_length:96000},reasoning_efforts:["low","high"]});
  assert.equal(metadata.contextWindow,96000);assert.deepEqual(metadata.inputModalities,["text","image"]);
  saveModelSettings(scope,id,{contextWindow:48000,effort:"high",inputModalities:["text"],supportedReasoningEfforts:["high"]});
  const first=configuredModel(scope,metadata);assert.equal(first.contextWindow,48000);assert.equal(first.capabilitySources.context,"user");
  assert.equal(modelSettings("different-provider",id).contextWindow,undefined);assert.equal(modelSettings(scope,"different-model").effort,undefined);
  const reloaded=await import("../gw/codex-models.mjs?settings-reload");assert.equal(reloaded.modelSettings(scope,id).effort,"high");
  saveModelSettings(scope,id,{contextWindow:0,inputModalities:null,supportedReasoningEfforts:null});
  const reset=configuredModel(scope,first);assert.equal(reset.contextWindow,96000);assert.deepEqual(reset.inputModalities,["text","image"]);assert.equal(reset.capabilitySources.context,"provider");
  assert.deepEqual(reset.supportedReasoningEfforts.map(e=>e.reasoningEffort),["low","high"]);
  assert.throws(()=>saveModelSettings(scope,id,{contextWindow:42}),/上下文/);
  assert.throws(()=>saveModelSettings(scope,id,{inputModalities:["unknown"]}),/模型能力/);
});

test("模型能力：精确 ID 和命名空间匹配；未知模型不按名称猜测", () => {
  const detail = modelDetails("fixture-vision", { providers });
  assert.deepEqual(detail.inputModalities, ["text", "image", "audio"]);
  assert.equal(detail.contextWindow, 128000);
  assert.deepEqual(detail.supportedReasoningEfforts.map(e => e.reasoningEffort), ["low", "high", "max"]);
  assert.equal(detail.capabilitySources.input, "models.dev");
  assert.equal(modelDetails("fixture/fixture-vision", { providers }).contextWindow, 128000);
  assert.equal(modelDetails("fixture-vision-new", { providers }).contextWindow, null);
  assert.deepEqual(modelDetails("fixture-vision-new", { providers }).inputModalities, []);
});

test("模型能力：有歧义时保持未知，直接服务商域名声明优先", () => {
  const ambiguous = { ...providers, other: { api: "https://other.test/v1", models: { "fixture-vision": { ...model, limit: { context: 64000 } } } } };
  assert.equal(modelDetails("fixture-vision", { providers: ambiguous }).contextWindow, null);
  assert.equal(modelDetails("fixture-vision", { providers: ambiguous, baseUrl: "https://other.test/v1" }).contextWindow, 64000);
});

test("模型能力：API 声明覆盖目录，包括空强度列表和关闭思考", () => {
  const row = { id: model.id, model: "wire-id", inputModalities: ["text"], context_window: 32000, supportedReasoningEfforts: [] };
  const detail = modelDetails(row, { providers, engine: true });
  assert.deepEqual(detail.inputModalities, ["text"]);
  assert.equal(detail.model, "wire-id"); assert.equal(detail.contextWindow, 32000);
  assert.deepEqual(detail.supportedReasoningEfforts, []);
  assert.equal(detail.capabilitySources.input, "codex");
  assert.equal(detail.capabilitySources.effort, "codex");
  assert.deepEqual(modelDetails({ id: model.id, reasoning: false }, { providers }).supportedReasoningEfforts, []);
  const budget = { fixture: { models: { budget: { ...model, id: "budget", reasoning_options: [{ type: "budget", min: 1024, max: 32000 }] } } } };
  assert.deepEqual(modelDetails("budget", { providers: budget }).supportedReasoningEfforts, [], "不能把预算虚构成强度枚举");
});

test("模型目录：持久化公开能力，刷新离线失败不影响模型选择", async () => {
  const baseUrl = "https://catalog-fixture.test/v1";
  rememberApiModels(baseUrl, [{ ...model, apiKey: "synthetic-private-key", contextWindow: 64000 }, { id: "boolean-reasoning", reasoning: true }]);
  const raw = fs.readFileSync(path.join(CFG.home, "coxdragon-model-catalog.json"), "utf8");
  assert.equal(raw.includes("synthetic-private-key"), false);
  assert.equal(customModels(baseUrl, model.id)[0].contextWindow, 64000);
  assert.equal(customModels(baseUrl, "manual-model")[0].isDefault, true);
  assert.equal(customModels(baseUrl, model.id).some(m => m.id === "manual-model"), false);
  const reloaded = await import("../gw/codex-models.mjs?reload-test");
  assert.equal(reloaded.customModels(baseUrl, model.id)[0].contextWindow, 64000);
  assert.equal(reloaded.customModels(baseUrl, model.id).find(m => m.id === "boolean-reasoning").reasoning, true);
  const unknownBefore = modelDetails("offline-unknown");
  await refreshModelCatalog({ force: true, fetchImpl: async (url, options) => {
    assert.equal(url, "https://models.dev/api.json");
    assert.deepEqual(options.headers, { accept: "application/json" });
    assert.equal(options.redirect, "error");
    throw new Error("Synthetic offline");
  } });
  assert.deepEqual(modelDetails("offline-unknown"), unknownBefore);
  await refreshModelCatalog({ force: true, fetchImpl: async () => new Response(JSON.stringify({ fixture: { models: { "fixture-vision": model } } })) });
  const cached = await import("../gw/codex-models.mjs?cache-test");
  assert.equal(cached.modelDetails(model.id).contextWindow, 128000, "重启后读取已更新的离线目录");
  assert.equal(reduceModelCatalog({ fixture: { api: "https://fixture.test", models: { x: { ...model, private: "discard" } } } }).providers.fixture.models.x.private, undefined);
});

test("模型模板：搜索、明确映射、重启和恢复自动匹配，保持请求 ID 与接口声明",async()=>{
  const scope="https://template.test/v1",id="provider-custom-id";
  const search=searchModelCatalog("Fixture Vision");assert.equal(search.total,1);assert.equal(search.models[0].referenceId,"fixture/fixture-vision");
  assert.equal(searchModelCatalog("missing-reference").total,0);
  rememberApiModels(scope,[{id},{id:"declared",context_window:32000,input_modalities:["text"],reasoning:false}]);
  saveModelSettingsBatch(scope,[{id,settings:{referenceId:"fixture/fixture-vision",displayName:"My model"}},{id:"declared",settings:{referenceId:"fixture/fixture-vision"}}]);
  const first=customModels(scope,id).find(m=>m.id===id);
  assert.equal(first.id,id);assert.equal(first.model,id);assert.equal(first.displayName,"My model");assert.equal(first.contextWindow,128000);
  assert.deepEqual(first.supportedReasoningEfforts.map(e=>e.reasoningEffort),["low","high","max"]);assert.equal(first.capabilitySources.effort,"models.dev");
  const declared=customModels(scope,id).find(m=>m.id==="declared");assert.equal(declared.contextWindow,32000);assert.deepEqual(declared.inputModalities,["text"]);assert.deepEqual(declared.supportedReasoningEfforts,[]);
  const reloaded=await import("../gw/codex-models.mjs?reference-reload");assert.equal(reloaded.customModels(scope,id).find(m=>m.id===id).contextWindow,128000);
  saveModelSettings(scope,id,{referenceId:null,displayName:""});
  const reset=configuredModel(scope,first);assert.equal(reset.contextWindow,null);assert.equal(reset.displayName,id);assert.deepEqual(reset.supportedReasoningEfforts,[]);
  assert.equal(customModels(scope,id).find(m=>m.id===id).contextWindow,null);
  assert.throws(()=>saveModelSettings(scope,id,{referenceId:"missing/model"}),/模板不存在/);
});

test("模型设置：批量无效不写入，撤销失败保存会删除新条目，目录移除模板保留手动设置",async()=>{
  const scope="https://rollback.test/v1",file=path.join(CFG.home,"coxdragon-model-settings.json");
  saveModelSettings(scope,"existing",{contextWindow:64000});const before=fs.readFileSync(file,"utf8");
  assert.throws(()=>saveModelSettingsBatch(scope,[{id:"existing",settings:{contextWindow:32000}},{id:"invalid",settings:{contextWindow:4}}]),/上下文/);
  assert.equal(fs.readFileSync(file,"utf8"),before);
  const rollback=saveModelSettingsBatch(scope,[{id:"existing",settings:{contextWindow:32000}},{id:"new",settings:{contextWindow:48000}}]);rollback();
  assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),JSON.parse(before));
  assert.equal(customModels(scope,"existing").some(m=>m.id==="new"),false);
  saveModelSettings(scope,"existing",{referenceId:"fixture/fixture-vision",effort:"high"});
  await refreshModelCatalog({force:true,fetchImpl:async()=>new Response(JSON.stringify({other:{models:{other:{id:"other"}}}}))});
  assert.equal(modelSettings(scope,"existing").contextWindow,64000);assert.equal(modelSettings(scope,"existing").effort,"high");
  assert.equal(modelSettings(scope,"existing").referenceId,undefined);
});
