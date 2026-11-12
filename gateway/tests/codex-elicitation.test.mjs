import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import mcp from '../web/mcp-elicitation.js';
const params={mode:'form',requestedSchema:{type:'object',properties:{name:{type:'string',minLength:1},confirm:{type:'boolean'},count:{type:'integer',minimum:0}},required:['name','confirm','count']}};
test('MCP form response preserves input types including false and zero',()=>{
 const content={name:'answer',confirm:false,count:0};assert.deepEqual(mcp.response(params,'accept',content),{action:'accept',content,_meta:null});
});
test('MCP form supports both extended form spellings',()=>{
 for(const mode of ['openai/form','openaiForm'])assert.equal(mcp.response({...params,mode},'accept',{name:'ok',confirm:true,count:2}).action,'accept');
});
test('MCP decline/cancel and URL completion return explicit null content',()=>{
 for(const action of ['decline','cancel'])assert.deepEqual(mcp.response(params,action,{secret:'discard'}),{action,content:null,_meta:null});
 assert.deepEqual(mcp.response({mode:'url'},'accept'),{action:'accept',content:null,_meta:null});
});
test('MCP invalid forms and unknown decisions are rejected before responding',()=>{
 assert.throws(()=>mcp.response(params,'accept'),/填写/);
 for(const content of [{name:'',confirm:true,count:1},{name:'ok',confirm:'false',count:1},{name:'ok',confirm:false,count:0.5},{name:'ok',confirm:true,count:-1}])assert.throws(()=>mcp.response(params,'accept',content));
 assert.throws(()=>mcp.response(params,'acceptForSession',{}),/无效/);
});
test('MCP enums, titled choices, arrays and primitive bounds validate',()=>{
 const schema={type:'object',properties:{choice:{type:'string',oneOf:[{const:'a',title:'A'},{const:'b',title:'B'}]},many:{type:'array',items:{type:'string',enum:['x','y']},minItems:1,maxItems:2,uniqueItems:true}},required:['choice','many']};
 mcp.validate(schema,{choice:'a',many:['x','y']});
 for(const content of [{choice:'c',many:['x']},{choice:'a',many:[]},{choice:'a',many:['z']},{choice:'a',many:['x','x']}])assert.throws(()=>mcp.validate(schema,content));
 assert.deepEqual(mcp.options({enum:['a'],enumNames:['Displayed title']}),[{value:'a',title:'Displayed title'}]);
});
test('MCP renderer escapes server-provided titles, keys, descriptions and defaults',()=>{
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const html=mcp.formHtml({type:'object',properties:{'x" onfocus="alert(1)':{type:'string',title:'<img src=x>',description:'<script>bad</script>',default:'"><img src=x>'}}},esc);
 assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(html.includes('&quot;'));
});
const source=fs.readFileSync(new URL('../gw/codex.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function approve('),source.indexOf('// ── 路由',source.indexOf('function approve(')));
function gateway(respond){const notifications=[];const S={rpc:{respond},approvals:new Map([['41',{id:41,method:'mcpServer/elicitation/request',params}]])};const ctx={S,mcpElicitation:mcp,broadcast:e=>notifications.push(e)};vm.runInNewContext(code+'\nglobalThis.answer=approve;',ctx);return {S,notifications,answer:ctx.answer};}
test('Actual gateway responder forwards content with the original numeric RPC id',()=>{
 const replies=[];const g=gateway((...args)=>replies.push(args));
 const content={name:'typed answer',confirm:false,count:0};g.answer('41','accept',undefined,content);
 assert.deepEqual(replies,[[41,{action:'accept',content,_meta:null}]]);assert.equal(g.S.approvals.size,0);assert.equal(g.notifications.length,1);
});
test('Actual gateway responder retains request after validation or RPC write failure',()=>{
 let writes=0;const g=gateway(()=>writes++);assert.throws(()=>g.answer('41','accept',undefined,{}));assert.equal(writes,0);assert.equal(g.S.approvals.size,1);
 const broken=gateway(()=>{throw Error('write failed');});assert.throws(()=>broken.answer('41','decline'),/write failed/);assert.equal(broken.S.approvals.size,1);assert.equal(broken.notifications.length,0);
});
