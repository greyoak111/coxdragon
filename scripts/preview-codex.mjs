#!/usr/bin/env node
// Isolated, simulated UI preview. Never connects to an installed gateway or account.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const web = fileURLToPath(new URL('../gateway/web/', import.meta.url));
const fixture = `
const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let logged = true;
const threads = [{id:'sample-ui',name:'重新装修安卓工作台',cwd:'~/workspace/coxdragon'}, {id:'sample-project',name:'了解项目结构',cwd:'~/workspace/demo'}];
const status = () => ({installed:true,ready:true,server:true,cwd:'~/workspace/coxdragon',account:logged ? {email:'preview@example.com',planType:'示例账户'} : null,threads,models:[{id:'preview',displayName:'示例模型',isDefault:true}],model:'preview'});
window.__cc = {esc:escapeHtml,copyText:async text => {try {await navigator.clipboard.writeText(text);return true;}catch{return false;}},toast:msg => { $('sub-title').textContent = msg; },closeDrawer:() => {if(innerWidth<1000)$('drawer').classList.add('hidden');},openPage:()=>{},api:async(p,o)=>{
  const body = o && o.body ? JSON.parse(o.body):{};
  if(p.endsWith('/status'))return status();
  if(p.endsWith('/threads'))return {threads};
  if(p.endsWith('/logout')){logged=false;return {};}
  if(p.endsWith('/login')){logged=true;setTimeout(()=>CODEX.refresh(),0);return {};}
  if(p.endsWith('/thread'))return {thread:{id:'preview-new',cwd:body.cwd||'~/workspace',turns:[]}};
  if(p.endsWith('/open-thread'))return {thread:{...threads.find(t=>t.id===body.threadId),turns:[{id:'sample-turn',items:[{id:'sample-user',type:'userMessage',content:[{type:'text',text:'按 ChatGPT 桌面端的思路，重新整理工作台。'}]},{id:'sample-agent',type:'agentMessage',text:'这是界面预览中的示例回复。侧栏、文件浏览器、终端和设置沿用 cccodroid，聊天区域集中显示正文和执行结果。'},{id:'sample-command',type:'commandExecution',command:'git diff --stat',status:'completed',aggregatedOutput:'示例输出 · 未执行任何命令',exitCode:0}]}]}};
  if(p.endsWith('/turn'))throw new Error('这是交互预览，不会发送消息或执行命令');
  return {};
}};
window.EventSource=class{close(){}};
$('pages').classList.remove('hidden');$('tab-codex').classList.remove('hidden');
$('side-new').onclick=()=>CODEX.newThread('~/workspace/coxdragon');
$('btn-menu').onclick=()=>{$('drawer').classList.toggle('hidden');};
$('btn-close-drawer').onclick=()=>{$('drawer').classList.add('hidden');};
$('side-acct').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';};
$('acct-name').textContent='切换深浅外观';$('acct-sub').textContent='交互预览 · 示例数据';
$('sub-title').textContent='交互预览 · 示例数据';
const resize=()=>{document.documentElement.classList.toggle('dock-l',innerWidth>=1000);$('drawer').classList.toggle('hidden',innerWidth<1000);};
addEventListener('resize',resize);resize();
`;
let html = fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
html = html.replace('</head>', `<style>:root{--lw:260px}#chat,#composer,#ctxbar{display:none!important}#side-recent{display:none}#pages{top:64px}#topbar{height:64px}#tb-tools,#tb-pins,#btn-more{display:none}.cx-main{height:100%}</style></head>`)
  .replace('</body>', `<script>${fixture}</script><script src="/mcp-elicitation.js"></script><script src="/codex.js"></script></body>`);
const mime={'.css':'text/css','.js':'text/javascript','.woff':'font/woff','.woff2':'font/woff2','.png':'image/png'};
const server=http.createServer((req,res)=>{
  if(req.url==='/' || req.url==='/preview.html'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
  // Only public web assets can be read, never arbitrary paths or application state.
  const rel=(req.url||'').split('?')[0].slice(1);
  if(!/^(?:mcp-elicitation\.js|style\.css|codex\.(?:css|js)|fonts\/[a-zA-Z0-9._-]+|icon\.png)$/.test(rel)){res.writeHead(404);return res.end();}
  try{res.setHeader('Content-Type',mime[path.extname(rel)]||'application/octet-stream');res.end(fs.readFileSync(path.join(web,rel)));}catch{res.writeHead(404);res.end();}
});
server.listen(Number(process.env.UI_PREVIEW_PORT||8765),'127.0.0.1',()=>console.log('Codex UI preview (simulated data): http://127.0.0.1:'+server.address().port));
