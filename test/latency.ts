import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LatencyStore} from '../server/latency.ts';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ac-latency-')),file=path.join(dir,'latency.sqlite');
const lookup=(id:string)=>id==='fixture'?{provider:'mock'}:undefined;
const sample={thread:'fixture',kind:'open',total_ms:10,server_ms:2,render_ms:3,wait_ms:7,events:10,bytes:1024,wire_bytes:600,width:390,height:844,touch:true};
let store=new LatencyStore(file,5);
try{
 assert.equal(store.record([{...sample,total_ms:-1},{...sample,thread:'missing'},{...sample,width:NaN},{...sample,render_ms:Infinity}],lookup),0);
 assert.equal(store.record(Array(21).fill(sample),lookup),0);
 assert.equal(store.record([10,20,30,400,800].map(total_ms=>({...sample,total_ms,prompt:'NEVER_STORE_THIS',url:'https://third-party.invalid'})),lookup),5);
 let data=store.summary();assert.equal(data.groups.open.median_ms,30);assert.equal(data.groups.open.p95_ms,800);assert.equal(data.groups['open/mock/mobile/visible'].count,5);assert.equal(data.recent.length,5);assert.ok(!JSON.stringify(data).includes('NEVER_STORE_THIS'));
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 store.close();store=new LatencyStore(file,5);assert.equal(store.summary().count,5);
 store.record([{...sample,kind:'cached',total_ms:5}],lookup);assert.equal(store.summary().count,5);assert.equal(store.summary().groups.cached.count,1);
 assert.equal(store.summary(Date.now()+15*86400_000).count,0);
 console.log('PASS local latency storage: validation, content whitelist, persistence, median/p95, device/provider grouping, private permissions, sample cap and retention');
}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
