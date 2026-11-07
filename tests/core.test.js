import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.js';
import { parseSatang, validDate } from '../server/validation.js';
import { extractCandidates } from '../server/ocr.js';

test('money and OCR suggestions retain exact values and require valid dates', () => {
  assert.equal(parseSatang('1234.05'),123405);
  assert.equal(parseSatang('0.01'),1);
  assert.equal(parseSatang('1.001'),null);
  assert.equal(parseSatang('-1'),null);
  assert.equal(validDate('2024-02-29'),true);
  assert.equal(validDate('2025-02-29'),false);
  const result=extractCandidates('Account balance 99,999.00\nTotal amount 350.25\n07/11/2569');
  assert.equal(result.amount,'350.25');
  assert.equal(result.date,'2026-11-07');
});

test('accounts are isolated and bookkeeping operations are guarded', async t => {
  const dataDir=mkdtempSync(join(tmpdir(),'slipbloom-test-'));
  const app=createApp({dataDir});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(dataDir,{recursive:true,force:true});});
  const call=async(path,{method='GET',body,session}={})=>{
    const headers={};
    if(body)headers['Content-Type']='application/json';
    if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrfToken;}
    const res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
    return {status:res.status,headers:res.headers,data:res.headers.get('content-type')?.includes('json')?await res.json():await res.text()};
  };
  const register=async(email,shopName)=>{
    const res=await call('/api/auth/register',{method:'POST',body:{email,password:'correct horse battery staple',shopName}});
    assert.equal(res.status,201);
    return {cookie:res.headers.get('set-cookie').split(';')[0],csrfToken:res.data.csrfToken,shop:res.data.shop};
  };
  const owner=await register('owner@example.com','Shop One');
  const other=await register('other@example.com','Shop Two');
  assert.equal((await call('/api/goals?month=2026-11',{session:owner})).data.targetSatang,null);
  assert.equal((await call('/api/goals',{method:'PUT',body:{month:'2026-11',target:'10000.50'},session:owner})).data.targetSatang,1000050);
  assert.equal((await call('/api/goals?month=2026-11',{session:other})).data.targetSatang,null);
  assert.equal((await call('/api/goals',{method:'PUT',body:{month:'2026-11',target:'0'},session:owner})).status,400);
  assert.equal((await call('/api/goals?month=2026-11',{session:owner})).data.targetSatang,1000050);
  assert.equal((await call('/api/goals',{method:'PUT',body:{month:'2026-11',target:'20000'},session:{...owner,csrfToken:'wrong'}})).status,403);
  assert.equal((await call('/api/goals?month=2026-11',{method:'DELETE',session:other})).status,200);
  assert.equal((await call('/api/goals?month=2026-11',{session:owner})).data.targetSatang,1000050);
  const entry={type:'expense',amount:'350.25',date:'2026-11-07',category:'ซื้อวัตถุดิบ',note:'=HYPERLINK("bad")'};
  assert.equal((await call('/api/transactions',{method:'POST',body:entry,session:owner})).status,201);
  assert.equal((await call('/api/transactions',{method:'POST',body:entry,session:owner})).status,409);
  assert.equal((await call('/api/transactions',{method:'POST',body:{...entry,forceDuplicate:true},session:owner})).status,201);
  assert.equal((await call('/api/transactions?month=2026-11',{session:other})).data.entries.length,0);
  const ownerEntries=(await call('/api/transactions?month=2026-11',{session:owner})).data.entries;
  assert.equal(ownerEntries.length,2);
  assert.equal(ownerEntries[0].amountSatang,35025);
  assert.equal((await call('/api/transactions/'+ownerEntries[0].id,{method:'PUT',body:{...entry,amount:'500.10'},session:other})).status,404);
  assert.equal((await call('/api/transactions/'+ownerEntries[0].id,{method:'PUT',body:{...entry,amount:'500.10'},session:owner})).data.entry.amountSatang,50010);
  assert.equal((await call('/api/transactions/'+ownerEntries[0].id,{method:'DELETE',session:other})).status,404);
  assert.equal((await call('/api/transactions/'+ownerEntries[0].id,{method:'DELETE',session:owner})).status,200);
  assert.equal((await call('/api/transactions?month=2026-11',{session:owner})).data.entries.length,1);
  assert.equal((await call('/api/transactions/'+ownerEntries[0].id+'/restore',{method:'POST',session:other})).status,404);
  assert.equal((await call('/api/transactions/'+ownerEntries[0].id+'/restore',{method:'POST',session:owner})).status,200);
  assert.equal((await call('/api/transactions?month=2026-11',{session:owner})).data.entries.length,2);
  const csv=await call('/api/export.csv?month=2026-11',{session:owner});
  assert.equal(csv.status,200);
  assert.match(csv.data,/"'=HYPERLINK/);
  assert.equal((await call('/api/transactions',{method:'POST',body:entry,session:{...owner,csrfToken:'wrong'}})).status,403);
  assert.equal((await call('/api/transactions',{method:'POST',body:entry})).status,401);
  const slipId='11111111-1111-4111-8111-111111111111';
  writeFileSync(join(dataDir,'uploads',slipId+'.png'),Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
  app.db.prepare('INSERT INTO slips(id,user_id,shop_id,stored_name,original_name,mime,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(slipId,app.db.prepare('SELECT owner_user_id FROM shops WHERE id=?').get(owner.shop.id).owner_user_id,owner.shop.id,slipId+'.png','slip.png','image/png',new Date().toISOString());
  assert.equal((await call('/api/slips/'+slipId,{session:other})).status,404);
  const ownSlip=await fetch(base+'/api/slips/'+slipId,{headers:{Cookie:owner.cookie}});
  assert.equal(ownSlip.status,200);
  assert.equal(ownSlip.headers.get('content-type'),'image/png');
});
