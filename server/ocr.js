import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime:'image/png', ext:'png' };
  if (bytes.length >= 3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return { mime:'image/jpeg', ext:'jpg' };
  if (bytes.length >= 12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return { mime:'image/webp', ext:'webp' };
  return null;
}

export function extractCandidates(text) {
  const lines = String(text || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const amounts = [];
  for (const line of lines) {
    for (const match of line.matchAll(/(?:฿|THB|บาท)?\s*([0-9]{1,9}(?:,[0-9]{3})*(?:\.[0-9]{2}))/gi)) {
      const value = Number(match[1].replaceAll(',',''));
      if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) continue;
      let score = /(?:จำนวนเงิน|ยอดโอน|ยอดเงิน|amount|total|transfer)/i.test(line) ? 3 : 1;
      if (/(?:คงเหลือ|balance|บัญชี|account|ref|อ้างอิง)/i.test(line)) score -= 2;
      amounts.push({ amount:value.toFixed(2), score, line:line.slice(0,100) });
    }
  }
  amounts.sort((a,b)=>b.score-a.score || Number(b.amount)-Number(a.amount));
  let date = null;
  for (const line of lines) {
    const m = line.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
    if (!m) continue;
    let y = Number(m[3]);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    if (y > 2400) y -= 543;
    const candidate = `${y}-${String(Number(m[2])).padStart(2,'0')}-${String(Number(m[1])).padStart(2,'0')}`;
    const parsed = new Date(candidate + 'T00:00:00Z');
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10)===candidate) { date=candidate; break; }
  }
  return { amounts: amounts.slice(0,5), amount:amounts[0]?.amount || null, date };
}

export async function recognizeSlip(filename) {
  try {
    const { stdout:langOutput } = await run('tesseract',['--list-langs'],{timeout:5000,maxBuffer:50000});
    const lang = /(?:^|\n)tha(?:\r?\n|$)/.test(langOutput) ? 'tha+eng' : 'eng';
    const { stdout } = await run('tesseract',[filename,'stdout','-l',lang,'--psm','6'],{timeout:30000,maxBuffer:2_000_000});
    return { ...extractCandidates(stdout), text:stdout.slice(0,10000), language:lang, status:'ok' };
  } catch (error) {
    return { ...extractCandidates(''), text:'', language:null, status:error.code==='ENOENT'?'unavailable':'failed' };
  }
}
