import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from './db.js';
import { hashPassword, verifyPassword, createSession, getSession, cookieValue, newId } from './security.js';
import { normalizeEmail, validateTransaction, validMonth, parseSatang } from './validation.js';
import { sniffImage, recognizeSlip } from './ocr.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(root, 'public');
const cookieName = 'slipbloom_session';
const authAttempts = new Map();
const mimeMap = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const asJson = (res, status, value, headers={}) => send(res,status,JSON.stringify(value),{'Content-Type':'application/json; charset=utf-8',...headers});
const nowIso = () => new Date().toISOString();
const log = (...args) => console.log(new Date().toISOString(),...args);

function send(res,status,body,headers={}) {
  res.writeHead(status,{
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'same-origin',
    'X-Frame-Options':'DENY',
    'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'",
    ...headers,
  });
  res.end(body);
}
function error(res,status,message) { asJson(res,status,{error:message}); }
async function bodyJson(req, maxBytes=7_000_000) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) throw Object.assign(new Error('ต้องส่งข้อมูลแบบ JSON'),{status:415});
  let size=0, chunks=[];
  for await (const chunk of req) {
    size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('ไฟล์หรือข้อมูลใหญ่เกินกำหนด'),{status:413});
    chunks.push(chunk);
  }
  try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('JSON object required');return value;}
  catch {throw Object.assign(new Error('JSON ไม่ถูกต้อง'),{status:400});}
}
function cleanText(value,max=80) {return String(value||'').trim().slice(0,max);}
function clientIp(req) {return req.socket.remoteAddress || 'unknown';}
function checkOrigin(req, origin) {
  if (req.method==='GET'||req.method==='HEAD') return true;
  return !req.headers.origin || req.headers.origin===origin;
}
function sessionCookie(token,secure) {return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30*86400}${secure?'; Secure':''}`;}
function clearCookie(secure) {return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure?'; Secure':''}`;}
function rowTransaction(row) {
  return {id:row.id,type:row.type,amount:(row.amount_satang/100).toFixed(2),amountSatang:row.amount_satang,date:row.transacted_on,category:row.category,note:row.note,source:row.source,slipId:row.slip_id,createdAt:row.created_at};
}
function csvCell(value) {const s=String(value??'');return '"'+(/^[\s]*[=+\-@]/.test(s)?"'"+s:s).replaceAll('"','""')+'"';}
function rateLimited(key) {
  const now=Date.now(), current=authAttempts.get(key)||[];
  const recent=current.filter(x=>x>now-15*60_000);
  if(recent.length>=8){authAttempts.set(key,recent);return true;}
  recent.push(now);authAttempts.set(key,recent);return false;
}

export function createApp(options={}) {
  const dataDir=resolve(options.dataDir||process.env.DATA_DIR||join(root,'data'));
  const origin=options.publicOrigin||process.env.PUBLIC_ORIGIN||`http://127.0.0.1:${process.env.PORT||8787}`;
  const secure=origin.startsWith('https://');
  const uploadDir=join(dataDir,'uploads');mkdirSync(uploadDir,{recursive:true,mode:0o700});
  const db=openDatabase(join(dataDir,'slipbloom.sqlite'));
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(nowIso());
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,origin), path=url.pathname;
      if (!checkOrigin(req,origin)) return error(res,403,'คำขอจากเว็บไซต์อื่นไม่ได้รับอนุญาต');
      if (path==='/healthz' && req.method==='GET') return asJson(res,200,{ok:true});
      if (path.startsWith('/api/')) {
        const session=getSession(db,cookieValue(req.headers.cookie,cookieName));
        if(path==='/api/auth/register' && req.method==='POST') {
          const b=await bodyJson(req), email=normalizeEmail(b.email), password=String(b.password||''), shopName=cleanText(b.shopName,80);
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) return error(res,400,'อีเมลไม่ถูกต้อง');
          if(password.length<12||password.length>128) return error(res,400,'รหัสผ่านต้องมี 12–128 ตัวอักษร');
          if(shopName.length<2) return error(res,400,'กรุณาใส่ชื่อร้านอย่างน้อย 2 ตัวอักษร');
          if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return error(res,409,'อีเมลนี้มีบัญชีแล้ว');
          const userId=newId(),shopId=newId(),stamp=nowIso();
          transaction(db,()=>{
            db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(userId,email,hashPassword(password),stamp);
            db.prepare('INSERT INTO shops(id,owner_user_id,name,created_at) VALUES(?,?,?,?)').run(shopId,userId,shopName,stamp);
          });
          const s=createSession(db,userId);
          return asJson(res,201,{user:{id:userId,email},shop:{id:shopId,name:shopName,currency:'THB'},csrfToken:s.csrfToken},{'Set-Cookie':sessionCookie(s.token,secure)});
        }
        if(path==='/api/auth/login' && req.method==='POST') {
          const b=await bodyJson(req), email=normalizeEmail(b.email), key=clientIp(req)+'|'+email;
          if(rateLimited(key)) return error(res,429,'ลองเข้าสู่ระบบอีกครั้งในภายหลัง');
          const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
          if(!user||!verifyPassword(String(b.password||''),user.password_hash)) return error(res,401,'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
          authAttempts.delete(key);
          const shop=db.prepare('SELECT id,name,currency FROM shops WHERE owner_user_id=?').get(user.id),s=createSession(db,user.id);
          return asJson(res,200,{user:{id:user.id,email:user.email},shop,csrfToken:s.csrfToken},{'Set-Cookie':sessionCookie(s.token,secure)});
        }
        if(!session) return error(res,401,'กรุณาเข้าสู่ระบบ');
        const shop=db.prepare('SELECT id,name,currency FROM shops WHERE owner_user_id=?').get(session.user_id);
        if(!shop) return error(res,403,'ไม่พบร้านของบัญชีนี้');
        if(req.method!=='GET' && req.method!=='HEAD' && req.headers['x-csrf-token']!==session.csrf_token) return error(res,403,'โทเค็นความปลอดภัยไม่ถูกต้อง');
        if(path==='/api/me' && req.method==='GET') return asJson(res,200,{user:{id:session.user_id,email:session.email},shop,csrfToken:session.csrf_token});
        if(path==='/api/goals' && req.method==='GET') {
          const month=url.searchParams.get('month');
          if(!validMonth(month)) return error(res,400,'เดือนไม่ถูกต้อง');
          const row=db.prepare('SELECT target_satang FROM monthly_goals WHERE shop_id=? AND month=?').get(shop.id,month);
          return asJson(res,200,{month,targetSatang:row?.target_satang||null});
        }
        if(path==='/api/goals' && req.method==='PUT') {
          const b=await bodyJson(req,10_000), month=String(b.month||''),targetSatang=parseSatang(b.target);
          if(!validMonth(month)) return error(res,400,'เดือนไม่ถูกต้อง');
          if(targetSatang===null) return error(res,400,'เป้าหมายต้องมากกว่า 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
          db.prepare(`INSERT INTO monthly_goals(shop_id,month,target_satang,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(shop_id,month) DO UPDATE SET target_satang=excluded.target_satang,updated_at=excluded.updated_at`)
            .run(shop.id,month,targetSatang,nowIso());
          return asJson(res,200,{month,targetSatang});
        }
        if(path==='/api/goals' && req.method==='DELETE') {
          const month=url.searchParams.get('month');
          if(!validMonth(month)) return error(res,400,'เดือนไม่ถูกต้อง');
          db.prepare('DELETE FROM monthly_goals WHERE shop_id=? AND month=?').run(shop.id,month);
          return asJson(res,200,{month,targetSatang:null});
        }
        if(path==='/api/auth/logout' && req.method==='POST') {
          db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
          return asJson(res,200,{ok:true},{'Set-Cookie':clearCookie(secure)});
        }
        if(path==='/api/slips/scan' && req.method==='POST') {
          const b=await bodyJson(req), match=String(b.image||'').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
          if(!match) return error(res,400,'รูปสลิปไม่ถูกต้อง');
          const bytes=Buffer.from(match[2],'base64'), kind=sniffImage(bytes);
          if(!kind||kind.mime!==match[1]||bytes.length<100||bytes.length>5_000_000) return error(res,400,'รองรับรูป JPG, PNG หรือ WebP ขนาดไม่เกิน 5 MB');
          const id=newId(), storedName=id+'.'+kind.ext, filename=join(uploadDir,storedName), originalName=cleanText(b.filename,120)||'slip.'+kind.ext;
          writeFileSync(filename,bytes,{mode:0o600,flag:'wx'});
          const result=await recognizeSlip(filename), stamp=nowIso();
          db.prepare('INSERT INTO slips(id,user_id,shop_id,stored_name,original_name,mime,ocr_text,created_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(id,session.user_id,shop.id,storedName,originalName,kind.mime,result.text,stamp);
          return asJson(res,201,{slipId:id,filename:originalName,ocr:{status:result.status,language:result.language,amount:result.amount,date:result.date,candidates:result.amounts},imageUrl:`/api/slips/${id}`});
        }
        const slipMatch=path.match(/^\/api\/slips\/([0-9a-f-]{36})$/);
        if(slipMatch && req.method==='GET') {
          const slip=db.prepare('SELECT stored_name,mime FROM slips WHERE id=? AND user_id=? AND shop_id=?').get(slipMatch[1],session.user_id,shop.id);
          if(!slip) return error(res,404,'ไม่พบสลิป');
          const filename=join(uploadDir,slip.stored_name);
          if(!existsSync(filename)) return error(res,404,'ไฟล์สลิปไม่พร้อมใช้งาน');
          return send(res,200,readFileSync(filename),{'Content-Type':slip.mime,'Content-Disposition':'inline','Content-Security-Policy':"default-src 'none'; sandbox"});
        }
        if(path==='/api/transactions' && req.method==='GET') {
          const month=url.searchParams.get('month');if(month&&!validMonth(month))return error(res,400,'เดือนไม่ถูกต้อง');
          const rows=month
            ? db.prepare(`SELECT * FROM transactions WHERE shop_id=? AND deleted_at IS NULL AND transacted_on>=? AND transacted_on<? ORDER BY transacted_on DESC,created_at DESC`).all(shop.id,month+'-01',nextMonth(month)+'-01')
            : db.prepare(`SELECT * FROM transactions WHERE shop_id=? AND deleted_at IS NULL ORDER BY transacted_on DESC,created_at DESC LIMIT 20`).all(shop.id);
          return asJson(res,200,{entries:rows.map(rowTransaction)});
        }
        if(path==='/api/transactions' && req.method==='POST') {
          const b=await bodyJson(req,100_000), value=validateTransaction(b);
          if(value.error) return error(res,400,value.error);
          let slip=null;
          if(b.slipId) {
            slip=db.prepare('SELECT id,claimed_at FROM slips WHERE id=? AND user_id=? AND shop_id=?').get(String(b.slipId),session.user_id,shop.id);
            if(!slip||slip.claimed_at)return error(res,400,'สลิปนี้ไม่พร้อมบันทึก');
          }
          const duplicate=db.prepare(`SELECT id FROM transactions WHERE shop_id=? AND deleted_at IS NULL AND transacted_on=? AND type=? AND amount_satang=? LIMIT 1`)
            .get(shop.id,value.date,value.type,value.amountSatang);
          if(duplicate && b.forceDuplicate!==true) return asJson(res,409,{error:'อาจมีรายการซ้ำ',duplicateId:duplicate.id});
          const id=newId(),stamp=nowIso();
          transaction(db,()=>{
            db.prepare(`INSERT INTO transactions(id,user_id,shop_id,type,amount_satang,transacted_on,category,note,source,slip_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
              .run(id,session.user_id,shop.id,value.type,value.amountSatang,value.date,value.category,value.note,slip?'slip':'manual',slip?.id||null,stamp);
            if(slip)db.prepare('UPDATE slips SET claimed_at=? WHERE id=? AND claimed_at IS NULL').run(stamp,slip.id);
          });
          return asJson(res,201,{entry:rowTransaction(db.prepare('SELECT * FROM transactions WHERE id=?').get(id))});
        }
        const txMatch=path.match(/^\/api\/transactions\/([0-9a-f-]{36})$/);
        if(txMatch && req.method==='PUT') {
          const b=await bodyJson(req,100_000), value=validateTransaction(b);
          if(value.error)return error(res,400,value.error);
          const existing=db.prepare('SELECT id FROM transactions WHERE id=? AND shop_id=? AND deleted_at IS NULL').get(txMatch[1],shop.id);
          if(!existing)return error(res,404,'ไม่พบรายการ');
          const duplicate=db.prepare('SELECT id FROM transactions WHERE shop_id=? AND id<>? AND deleted_at IS NULL AND transacted_on=? AND type=? AND amount_satang=? LIMIT 1').get(shop.id,txMatch[1],value.date,value.type,value.amountSatang);
          if(duplicate && b.forceDuplicate!==true)return asJson(res,409,{error:'อาจมีรายการซ้ำ',duplicateId:duplicate.id});
          db.prepare('UPDATE transactions SET type=?,amount_satang=?,transacted_on=?,category=?,note=? WHERE id=? AND shop_id=?').run(value.type,value.amountSatang,value.date,value.category,value.note,txMatch[1],shop.id);
          return asJson(res,200,{entry:rowTransaction(db.prepare('SELECT * FROM transactions WHERE id=?').get(txMatch[1]))});
        }
        const restoreMatch=path.match(/^\/api\/transactions\/([0-9a-f-]{36})\/restore$/);
        if(restoreMatch && req.method==='POST') {
          const result=db.prepare('UPDATE transactions SET deleted_at=NULL WHERE id=? AND shop_id=? AND deleted_at IS NOT NULL').run(restoreMatch[1],shop.id);
          if(!result.changes)return error(res,404,'ไม่พบรายการที่ลบ');
          return asJson(res,200,{ok:true});
        }
        if(txMatch && req.method==='DELETE') {
          const result=db.prepare('UPDATE transactions SET deleted_at=? WHERE id=? AND shop_id=? AND deleted_at IS NULL').run(nowIso(),txMatch[1],shop.id);
          if(!result.changes)return error(res,404,'ไม่พบรายการ');
          return asJson(res,200,{ok:true});
        }
        if(path==='/api/export.csv' && req.method==='GET') {
          const month=url.searchParams.get('month');if(month&&!validMonth(month))return error(res,400,'เดือนไม่ถูกต้อง');
          const rows=month
            ? db.prepare(`SELECT * FROM transactions WHERE shop_id=? AND deleted_at IS NULL AND transacted_on>=? AND transacted_on<? ORDER BY transacted_on,created_at`).all(shop.id,month+'-01',nextMonth(month)+'-01')
            : db.prepare(`SELECT * FROM transactions WHERE shop_id=? AND deleted_at IS NULL ORDER BY transacted_on,created_at`).all(shop.id);
          const header=['วันที่','ประเภท','หมวดหมู่','จำนวนเงิน (บาท)','บันทึกช่วยจำ','ที่มา'];
          const data=rows.map(r=>[r.transacted_on,r.type,r.category,(r.amount_satang/100).toFixed(2),r.note,r.source]);
          const csv='\ufeff'+[header,...data].map(row=>row.map(csvCell).join(',')).join('\r\n');
          return send(res,200,csv,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="slipbloom-${month||'all'}.csv"`});
        }
        return error(res,404,'ไม่พบ API');
      }
      if(req.method!=='GET'&&req.method!=='HEAD') return error(res,405,'วิธีเรียกไม่ถูกต้อง');
      const requested=path==='/'?'/index.html':path;
      const filename=resolve(publicDir,'.'+decodeURIComponent(requested));
      if(!filename.startsWith(publicDir+'/')) return error(res,403,'ไม่อนุญาต');
      if(!existsSync(filename)) return error(res,404,'ไม่พบไฟล์');
      const ext=extname(filename),mime=mimeMap[ext];
      if(!mime)return error(res,404,'ไม่พบไฟล์');
      return send(res,200,req.method==='HEAD'?'':readFileSync(filename),{'Content-Type':mime});
    } catch (e) {
      if(e.status) return error(res,e.status,e.message);
      log('request error',e);
      if(!res.headersSent) error(res,500,'เกิดข้อผิดพลาดในระบบ'); else res.end();
    }
  });
  return {server,db,dataDir};
}
function nextMonth(month) {const [y,m]=month.split('-').map(Number);return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8787),app=createApp();
  app.server.listen(port,host,()=>log(`SlipBloom listening on http://${host}:${port}`));
  const shutdown=()=>app.server.close(()=>{app.db.close();process.exit(0);});
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
