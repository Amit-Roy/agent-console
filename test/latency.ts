import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
 assert.equal(data.groups['open/visible/recent'].count,5);assert.equal(data.groups['open/visible/recent'].median_ms,30);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 store.close();store=new LatencyStore(file,5);assert.equal(store.summary().count,5);
 store.record([{...sample,kind:'cached',total_ms:5}],lookup);assert.equal(store.summary().count,5);assert.equal(store.summary().groups.cached.count,1);
 store.record([{...sample,kind:'refresh',total_ms:2000}],lookup);assert.equal(store.summary().groups.refresh.count,1);assert.equal(store.summary().groups.cached.median_ms,5);
 assert.equal(store.summary(Date.now()+15*86400_000).count,0);
 assert.equal(store.record([
  {...sample,kind:'viewer_open',module_ms:'12'},
  {...sample,kind:'viewer_tree',server_ms:300001},
  {...sample,kind:'viewer_module',module_ms:Infinity},
  {...sample,kind:'viewer_tree',events:100001},
  {...sample,kind:'viewer_open',bytes:64*1024*1024+1},
  {...sample,kind:'viewer_unknown'},
 ],lookup),0);
 assert.equal(store.record([
  {...sample,kind:'viewer_open',total_ms:50,module_ms:15,prepare_ms:16,roundtrip_ms:20,decode_ms:2,server_ms:4,render_ms:8,path:'/NEVER_STORE_VIEWER_PATH',content:'NEVER_STORE_VIEWER_CONTENT'},
  {...sample,kind:'viewer_open',total_ms:10,module_ms:0,prepare_ms:0,roundtrip_ms:3,decode_ms:1,server_ms:1,render_ms:2},
  {...sample,kind:'viewer_tree',total_ms:12,events:15,render_ms:2},
  {...sample,kind:'viewer_module',total_ms:15,module_ms:15},
 ],lookup),4);
 data=store.summary();
 assert.equal(data.groups.viewer_open.count,2);
 assert.equal(data.groups.viewer_open.stages.module_ms.median_ms,0);
 assert.equal(data.groups.viewer_open.stages.server_ms.p95_ms,4);
 assert.equal(data.groups.viewer_open.stages.render_ms.max_ms,8);
 assert.equal(data.groups.viewer_open.counts.bytes.total,2048);
 assert.equal(data.groups['viewer_open/mock/mobile/visible'].count,2);
 assert.equal(data.groups['viewer_open/visible/recent'].count,2);
 assert.equal(data.groups.viewer_tree.counts.events.max,15);
 assert.equal(data.groups.viewer_module.stages.module_ms.mean_ms,15);
 assert.ok(!JSON.stringify(data).includes('NEVER_STORE_VIEWER'));
 store.record(Array(3).fill({...sample,kind:'viewer_tree'}),lookup);assert.equal(store.summary().count,5);
 assert.equal(store.summary(Date.now()+15*86400_000).count,0);
 // Upgrade an existing database without losing history or interpreting absent stage times as zero.
 const oldFile=path.join(dir,'old.sqlite'),old=new DatabaseSync(oldFile);
 old.exec(`CREATE TABLE latency (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,thread TEXT NOT NULL,provider TEXT NOT NULL,kind TEXT NOT NULL,total_ms REAL NOT NULL,server_ms REAL,render_ms REAL,wait_ms REAL,events INTEGER,bytes INTEGER,width INTEGER NOT NULL,height INTEGER NOT NULL,touch INTEGER NOT NULL,hidden INTEGER NOT NULL)`);
 old.prepare('INSERT INTO latency(at,thread,provider,kind,total_ms,width,height,touch,hidden) VALUES(?,?,?,?,?,?,?,?,?)').run(Date.now(),'fixture','mock','open',7,390,844,1,0);
 old.close();
 const upgraded=new LatencyStore(oldFile);
 try{
  assert.equal(upgraded.summary().groups.open.median_ms,7);
  assert.equal(upgraded.record([{...sample,kind:'viewer_open',module_ms:12}],lookup),1);
  const migrated=upgraded.summary();
  assert.equal(migrated.groups.viewer_open.stages.module_ms.median_ms,12);
  assert.equal(migrated.groups.open.count,1);assert.equal(migrated.recent.find((s:any)=>s.kind==='open').module_ms,null);
 }finally{upgraded.close();}
 console.log('PASS local latency storage: validation, content whitelist, persistence, median/p95, device/provider grouping, private permissions, sample cap and retention');
 console.log('PASS viewer latency kinds/stages/counts, bounded numeric validation, content whitelist, retention and old-database migration');
}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
