export const PEOPLE = ['Carlos', 'María'];
export const CATEGORIES = ['Alimentación', 'Casa', 'Suministros', 'Transporte', 'Ocio', 'Salud', 'Otros'];
export const STORES = ['Supermercado', 'Mercadona', 'Lidl', 'Carrefour', 'Amazon', 'Bazar / chino', 'Restaurante', 'Farmacia', 'Gasolinera', 'Otros'];
export const TABLES = ['expenses', 'tasks', 'shopping', 'messages', 'settlements', 'budgets'];
export function fail(message, code = 'INVALID') { const e = new Error(message); e.code = code; throw e; }
export function text(value, max = 160, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) fail('Revisa los campos de texto.');
  return value.trim();
}
export function oneOf(value, allowed) { if (!allowed.includes(value)) fail('Opción no válida.'); return value; }
export function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('Cantidad no válida.'); return value; }
export function validDate(value, optional = false) {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31' || !Number.isFinite(new Date(value+'T12:00:00Z').getTime()) || new Date(value+'T12:00:00Z').toISOString().slice(0,10) !== value) fail('Fecha no válida.');
  return value;
}
export function validTime(value, optional = false) {
  if (optional && (value === '' || value === undefined || value === null)) return '';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Hora no válida.');
  return value;
}
// Avisos: lista de minutos de antelación ('1440' = 1 día, '60' = 1 h, '15' = 15 min, '0' = a la hora). Vacía = sin avisos.
export const REMINDERS = ['1440', '60', '15', '0'];
export function reminders(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  if (list.length > 4) fail('Avisos no válidos.');
  return REMINDERS.filter(r => list.map(v => oneOf(String(v), REMINDERS)).includes(r));
}
export function cents(value) {
  const v = String(value).trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(v)) fail('Introduce un importe positivo con un máximo de dos decimales.');
  return integer(Math.round(Number(v) * 100), 1, 100000000);
}
export function today() { return new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Madrid', year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
export function monthNow() { return today().slice(0,7); }
export function nextDate(date, recurrence) {
  const d = new Date(validDate(date) + 'T12:00:00Z');
  if (recurrence === 'monthly') { const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+1); const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, end)); }
  else d.setUTCDate(d.getUTCDate() + ({daily:1,weekly:7}[recurrence] || 0));
  return d.toISOString().slice(0,10);
}
export function validateRecord(table, input) {
  if (!TABLES.includes(table) || !input || typeof input !== 'object') fail('Registro no válido.');
  switch (table) {
    case 'expenses': { const purpose=oneOf(input.purpose,['household','Carlos','María']); return {purpose, store:oneOf(input.store,STORES), title:text(input.title), amount:integer(input.amount,1,100000000), date:validDate(input.date), paidBy:oneOf(input.paidBy,PEOPLE), category:oneOf(input.category,CATEGORIES), carlosPercent:purpose==='Carlos'?100:purpose==='María'?0:integer(input.carlosPercent,0,100), notes:text(input.notes || '',1000,true)}; }
    case 'tasks': return {title:text(input.title), assignedTo:oneOf(input.assignedTo,[...PEOPLE,'Ambos']), due:validDate(input.due || '',true), time:input.due?validTime(input.time || '',true):'', remind:reminders(input.remind), recurrence:oneOf(input.recurrence,['none','daily','weekly','monthly']), done:!!input.done, notes:text(input.notes || '',1000,true)};
    case 'shopping': return {title:text(input.title,100), quantity:text(input.quantity || '1',40), category:oneOf(input.category,['Alimentación','Limpieza','Otros']), checked:!!input.checked};
    case 'messages': return {title:text(input.title,120), body:text(input.body,2000), to:oneOf(input.to,[...PEOPLE,'Ambos']), resolved:!!input.resolved};
    case 'settlements': return {from:oneOf(input.from,PEOPLE), amount:integer(input.amount,1,100000000), date:validDate(input.date), notes:text(input.notes || '',1000,true)};
    case 'budgets': if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) fail('Mes no válido.'); return {month:input.month, amount:integer(input.amount,0,100000000)};
  }
}
export function balance(expenses, settlements) {
  let carlos = 0;
  for (const e of expenses) carlos += (e.paidBy === 'Carlos' ? e.amount : 0) - Math.round(e.amount * e.carlosPercent / 100);
  for (const s of settlements) carlos += s.from === 'Carlos' ? s.amount : -s.amount;
  return carlos; // positivo: María debe a Carlos; negativo: Carlos debe a María
}
export function emptyState() { return Object.fromEntries(TABLES.map(t=>[t,[]])); }
