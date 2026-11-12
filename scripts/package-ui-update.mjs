#!/usr/bin/env node
// Package a web-only update against the verified, installed APK. Native code stays byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readZip,writeZip,signApk} from './apklib.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const build=path.join(root,'.build-ui');
fs.mkdirSync(build,{recursive:true});
const base=process.env.BASE_APK || path.join(build,'installed-base.apk');
const keyPath=process.env.KEY || path.join(process.env.HOME,'.bldtools/coxdragon-release.json');
const expected='93f4d801b104b160140644b9d13109756d20cf8cc1d875fec58ef93835b2b9fb';
const info=execFileSync('apksigner',['verify','--print-certs',base],{encoding:'utf8'});
if(!info.includes('certificate SHA-256 digest: '+expected))throw Error('Base APK certificate mismatch');
const key=JSON.parse(fs.readFileSync(keyPath,'utf8'));
const cert=new crypto.X509Certificate(key.cert);
if(cert.fingerprint256.replaceAll(':','').toLowerCase()!==expected || !cert.checkPrivateKey(crypto.createPrivateKey(key.key)))throw Error('Signing key does not match the installed release');
const entries=readZip(fs.readFileSync(base)).filter(e=>!e.name.startsWith('META-INF/'));
const replace=(name,data)=>{
 const e=entries.find(e=>e.name===name);if(!e)throw Error('Expected APK entry missing: '+name);e.data=data;
};
const files=['codex.css','codex.js','index.html','lang-en.js','app/13-nav-menus.js','app/19-boot.js'];
for(const rel of files)replace('assets/app/web/'+rel,fs.readFileSync(path.join(root,'gateway/web',rel)));
// Increment manifest metadata using the Android binary XML structure (no resource recompilation).
const manifest=Buffer.from(entries.find(e=>e.name==='AndroidManifest.xml').data);
let pool=null,strings=[];
function len8(buf,p){const a=buf[p++];return a&128?[(a&127)*256+buf[p++],p]:[a,p];}
function len16(buf,p){const a=buf.readUInt16LE(p);p+=2;return a&32768?[(a&32767)*65536+buf.readUInt16LE(p),p+2]:[a,p];}
for(let off=8;off<manifest.length;){
 const type=manifest.readUInt16LE(off), header=manifest.readUInt16LE(off+2), size=manifest.readUInt32LE(off+4);
 if(!size || off+size>manifest.length)throw Error('Invalid binary XML chunk');
 if(type===1){
  const count=manifest.readUInt32LE(off+8),utf8=!!(manifest.readUInt32LE(off+16)&256),start=off+manifest.readUInt32LE(off+20);
  pool={off,header,count,utf8,start};
  for(let i=0;i<count;i++){
   let p=start+manifest.readUInt32LE(off+header+i*4),length;
   if(utf8){[,p]=len8(manifest,p);[length,p]=len8(manifest,p);strings.push({text:manifest.toString('utf8',p,p+length),p,length});}
   else{[length,p]=len16(manifest,p);strings.push({text:manifest.toString('utf16le',p,p+length*2),p,length:length*2});}
  }
 }
 off+=size;
}
let versionPatched=false,namePatched=false;
for(let off=8;off<manifest.length;){
 const type=manifest.readUInt16LE(off),size=manifest.readUInt32LE(off+4);
 if(type===0x102 && strings[manifest.readUInt32LE(off+20)]?.text==='manifest'){
  const ext=off+16,start=manifest.readUInt16LE(ext+8),step=manifest.readUInt16LE(ext+10),count=manifest.readUInt16LE(ext+12);
  for(let i=0;i<count;i++){
   const a=ext+start+i*step,name=strings[manifest.readUInt32LE(a+4)]?.text;
   if(name==='versionCode'){
    if(![3,4].includes(manifest.readUInt32LE(a+16)))throw Error('Expected coxdragon versionCode 3 or 4');
    manifest.writeUInt32LE(4,a+16);versionPatched=true;
   }
   if(name==='versionName'){
    const s=strings[manifest.readUInt32LE(a+16)];if(!['0.1.2','0.1.3'].includes(s?.text))throw Error('Expected coxdragon versionName 0.1.2 or 0.1.3');
    const data=Buffer.from('0.1.3',pool.utf8?'utf8':'utf16le');if(data.length!==s.length)throw Error('Manifest string width changed');
    data.copy(manifest,s.p);namePatched=true;
   }
  }
 }
 off+=size;
}
if(!versionPatched||!namePatched)throw Error('Manifest version metadata not found');
replace('AndroidManifest.xml',manifest);
const app=entries.filter(e=>e.name.startsWith('assets/app/') && !e.name.endsWith('/'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const payload=app.filter(e=>!['assets/app/FILES','assets/app/TAG'].includes(e.name)).sort((a,b)=>a.name.localeCompare(b.name,'en'));
const tag=crypto.createHash('sha256').update(payload.map(e=>e.name+' '+sha(e.data)).join('\n')).digest('hex').slice(0,12);
replace('assets/app/TAG',Buffer.from(tag+'\n'));
const list=app.filter(e=>e.name!=='assets/app/FILES').map(e=>sha(e.data)+' '+e.name.slice('assets/app/'.length)).sort((a,b)=>a.slice(65)<b.slice(65)?-1:1);
replace('assets/app/FILES',Buffer.from(list.join('\n')+'\n'));
for(const e of entries)e.align=e.name==='resources.arsc'?4:e.name.endsWith('.so')?4096:0;
const unsigned=path.join(build,'ui-unsigned.apk');fs.writeFileSync(unsigned,writeZip(entries));
const out=path.join(root,'dist','coxdragon-0.1.3-chat-ui.apk');fs.mkdirSync(path.dirname(out),{recursive:true});
signApk(unsigned,out,[],keyPath);
execFileSync('apksigner',['verify','--verbose',out],{stdio:'inherit'});
const badging=execFileSync('aapt2',['dump','badging',out],{encoding:'utf8'}).split('\n')[0];
if(!badging.includes("versionCode='4'")||!badging.includes("versionName='0.1.3'"))throw Error('Output version validation failed');
// Verify all packaged files and every untouched entry after signing, using actual output bytes.
const result=readZip(fs.readFileSync(out)),byName=new Map(result.map(e=>[e.name,e]));
for(const e of entries)if(!byName.get(e.name)?.data.equals(e.data))throw Error('Packaged data changed: '+e.name);
const original=readZip(fs.readFileSync(base));
for(const e of original.filter(e=>e.name==='classes.dex'||e.name.startsWith('lib/')))if(!byName.get(e.name)?.data.equals(e.data))throw Error('Native code changed: '+e.name);
console.log(badging);console.log('Verified app manifest: '+list.length+' files; existing native code and engine preserved.');console.log(out);console.log('SHA256 '+sha(fs.readFileSync(out)));
