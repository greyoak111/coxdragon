import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { modelDetails, reduceModelCatalog, refreshModelCatalog, rememberApiModels, customModels } from "../gw/codex-models.mjs";

const model = { id: "fixture-vision", name: "Fixture Vision", reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  modalities: { input: ["text", "image", "audio"], output: ["text"] }, limit: { context: 128000 } };
const providers = { fixture: { api: "https://fixture.test/v1", models: { "fixture-vision": model } } };

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
  rememberApiModels(baseUrl, [{ ...model, apiKey: "synthetic-private-key", contextWindow: 64000 }]);
  const raw = fs.readFileSync(path.join(CFG.home, "coxdragon-model-catalog.json"), "utf8");
  assert.equal(raw.includes("synthetic-private-key"), false);
  assert.equal(customModels(baseUrl, model.id)[0].contextWindow, 64000);
  assert.equal(customModels(baseUrl, "manual-model")[0].isDefault, true);
  assert.equal(customModels(baseUrl, model.id).some(m => m.id === "manual-model"), false);
  const reloaded = await import("../gw/codex-models.mjs?reload-test");
  assert.equal(reloaded.customModels(baseUrl, model.id)[0].contextWindow, 64000);
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
