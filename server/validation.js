export function parseSatang(value) {
  const s = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(s)) return null;
  const [baht, decimal = ''] = s.split('.');
  const n = Number(baht) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y,m,d] = value.split('-').map(Number);
  const actual = new Date(Date.UTC(y,m-1,d));
  return actual.getUTCFullYear()===y && actual.getUTCMonth()===m-1 && actual.getUTCDate()===d;
}
export function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value)); }
export function normalizeEmail(value) { return String(value ?? '').trim().toLowerCase(); }
export function validateTransaction(value) {
  const type = String(value?.type || ''), amountSatang = parseSatang(value?.amount), date = String(value?.date || ''), category = String(value?.category || '').trim(), note = String(value?.note || '').trim();
  if (!['income','expense','personal'].includes(type)) return { error:'เลือกประเภทรายการให้ถูกต้อง' };
  if (amountSatang === null) return { error:'จำนวนเงินต้องมากกว่า 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง' };
  if (!validDate(date)) return { error:'วันที่ไม่ถูกต้อง' };
  if (!category || category.length > 80) return { error:'หมวดหมู่ต้องมี 1–80 ตัวอักษร' };
  if (note.length > 500) return { error:'บันทึกช่วยจำยาวเกิน 500 ตัวอักษร' };
  return { type, amountSatang, date, category, note };
}
