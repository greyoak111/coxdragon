/* Shared form/response adapter for Codex 0.166.0 MCP elicitations. No network or storage. */
(function (root) {
  "use strict";
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function options(s) {
    if (Array.isArray(s.enum)) return s.enum.map((v, i) => ({ value: v, title: (s.enumNames || [])[i] || String(v) }));
    if (Array.isArray(s.oneOf) && s.oneOf.every(o => object(o) && own(o, "const"))) return s.oneOf.map(o => ({ value: o.const, title: o.title || String(o.const) }));
    return [];
  }
  function validate(s, value, path = "填写内容", depth = 0) {
    if (depth > 16) throw new Error("表单层级过深");
    if (s === false) throw new Error(path + "不接受此内容");
    if (!object(s)) return;
    const fail = text => { throw new Error(path + "：" + text); };
    if (Array.isArray(s.enum) && !s.enum.some(v => same(v, value))) fail("请选择列出的选项");
    if (own(s, "const") && !same(s.const, value)) fail("选项不匹配");
    for (const key of ["oneOf", "anyOf"]) if (Array.isArray(s[key])) {
      const matches = s[key].filter(x => { try { validate(x, value, path, depth + 1); return true; } catch { return false; } }).length;
      if (!matches || (key === "oneOf" && matches !== 1)) fail("内容不符合可选格式");
    }
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    if (types.length && !types.some(t => t === "null" ? value === null : t === "object" ? object(value) : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) : t === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === t)) fail("内容类型不正确");
    if (object(value)) {
      for (const k of s.required || []) if (!own(value, k)) fail("请填写 " + k);
      for (const [k, v] of Object.entries(value)) {
        if (object(s.properties) && own(s.properties, k)) validate(s.properties[k], v, path + " / " + k, depth + 1);
        else if (s.additionalProperties === false) fail("包含未请求的字段");
      }
    }
    if (Array.isArray(value)) {
      if (s.minItems != null && value.length < s.minItems) fail("选择的项目太少");
      if (s.maxItems != null && value.length > s.maxItems) fail("选择的项目太多");
      if (s.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail("选项不能重复");
      if (s.items) value.forEach((v, i) => validate(s.items, v, path + " / " + (i + 1), depth + 1));
    }
    if (typeof value === "string") {
      const n = Array.from(value).length;
      if (s.minLength != null && n < s.minLength) fail("文字太短");
      if (s.maxLength != null && n > s.maxLength) fail("文字太长");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("请输入有效数字");
      if (s.minimum != null && value < s.minimum) fail("数字小于下限");
      if (s.maximum != null && value > s.maximum) fail("数字大于上限");
    }
  }
  function formHtml(schema, esc) {
    if (!object(schema) || schema.type !== "object" || !object(schema.properties)) return `<label class="cx-mcp-field">填写内容<textarea data-mcp-field="" data-kind="root-json" rows="5">${esc(JSON.stringify(schema && schema.default || {}, null, 2))}</textarea></label>`;
    return Object.entries(schema.properties).map(([key, s]) => {
      s = object(s) ? s : {};
      const required = (schema.required || []).includes(key);
      const attr = `data-mcp-field="${esc(key)}"`;
      const opts = s.type === "array" ? options(s.items || {}) : options(s);
      let control;
      if (opts.length) {
        const multi = s.type === "array", defaults = multi ? s.default || [] : [s.default];
        control = `<select ${attr} data-kind="${multi ? "multi" : "choice"}"${multi ? ' multiple size="4"' : ""}>${multi ? "" : '<option value="">请选择…</option>'}${opts.map(o => `<option value="${esc(JSON.stringify(o.value))}"${defaults.some(d => same(d, o.value)) ? " selected" : ""}>${esc(o.title)}</option>`).join("")}</select>`;
      } else if (s.type === "boolean") control = `<select ${attr} data-kind="boolean"><option value="">请选择…</option><option value="true"${s.default === true ? " selected" : ""}>是</option><option value="false"${s.default === false ? " selected" : ""}>否</option></select>`;
      else if (s.type === "number" || s.type === "integer") control = `<input ${attr} data-kind="number" type="number" step="${s.type === "integer" ? "1" : "any"}" value="${esc(s.default ?? "")}">`;
      else if (s.type === "string" || !s.type) control = `<input ${attr} data-kind="string" type="${s.format === "email" ? "email" : "text"}" value="${esc(s.default ?? "")}" autocomplete="off">`;
      else control = `<textarea ${attr} data-kind="json" rows="4">${s.default === undefined ? "" : esc(JSON.stringify(s.default, null, 2))}</textarea>`;
      return `<label class="cx-mcp-field"><span>${esc(s.title || key)}${required ? ' <small>必填</small>' : ""}</span>${s.description ? `<small>${esc(s.description)}</small>` : ""}${control}</label>`;
    }).join("");
  }
  function readForm(schema, card) {
    const content = Object.create(null);
    for (const el of card.querySelectorAll("[data-mcp-field]")) {
      const key = el.dataset.mcpField, kind = el.dataset.kind, raw = el.value;
      if (kind === "root-json") { const value = JSON.parse(raw); validate(schema, value); return value; }
      if (kind === "multi") { content[key] = Array.from(el.options).filter(o => o.selected).map(o => JSON.parse(o.value)); continue; }
      if (raw === "" && kind !== "string") continue;
      if (raw === "" && !(schema.required || []).includes(key)) continue;
      content[key] = kind === "number" ? Number(raw) : ["choice", "boolean", "json"].includes(kind) ? JSON.parse(raw) : raw;
    }
    validate(schema, content); return content;
  }
  function response(params, action, content) {
    if (!["accept", "decline", "cancel"].includes(action)) throw new Error("无效的输入决定");
    if (action !== "accept") return { action, content: null, _meta: null };
    if (params.mode === "url") return { action, content: null, _meta: null };
    if (!["form", "openai/form", "openaiForm"].includes(params.mode)) throw new Error("尚不支持这种 MCP 输入方式");
    if (content === undefined || content === null) throw new Error("请填写表单内容后提交");
    validate(params.requestedSchema, content);
    return { action, content, _meta: null };
  }
  const adapter = { options, validate, formHtml, readForm, response };
  if (typeof module === "object" && module.exports) module.exports = adapter;
  else root.CXMcpElicitation = adapter;
})(typeof globalThis === "object" ? globalThis : this);
