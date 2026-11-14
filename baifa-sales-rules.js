// Shared, deterministic rules for draft sales documents. No credit approval.
export const isGenerator = p => /^TRPE/i.test(String(p?.code || p?.sku || "")) ||
  (/baifa/i.test(`${p?.brand || ""} ${p?.name || ""}`) &&
   /generador|grupo electr[oó]geno|genset/i.test(`${p?.name || ""} ${p?.category || ""}`));
export const cents = value => Math.round(Number(value) * 100);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const money = (value, label) => {
  if (value === "" || value == null || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e9)
    fail(`${label}: indica un monto válido.`);
  return cents(value);
};
export function financingSchedule(total, plan) {
  const amount = money(total, "Total");
  if (!plan || !["contado", "financiado"].includes(plan.mode)) fail("Selecciona la forma de pago.");
  if (plan.mode === "contado") return { initial: amount, principal: 0, surcharge: 0, payable: amount, payments: [] };
  const initial = money(plan.initial, "Inicial");
  const surcharge = money(plan.surcharge, "Recargo fijo acordado");
  const count = Number(plan.count);
  if (initial >= amount) fail("La inicial debe ser menor que el total para financiar.");
  if (!Number.isInteger(count) || count < 1 || count > 60) fail("Indica entre 1 y 60 cuotas.");
  if (!["mensual", "quincenal", "semanal"].includes(plan.frequency)) fail("Selecciona la periodicidad.");
  if (!/^(20\d{2})-\d{2}-\d{2}$/.test(plan.firstDate || "")) fail("Indica una primera cuota entre 2000 y 2099.");
  const date = new Date(`${plan.firstDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== plan.firstDate) fail("Fecha de primera cuota inválida.");
  const principal = amount - initial;
  const debt = principal + surcharge;
  const installment = Math.floor(debt / count);
  const payments = Array.from({ length: count }, (_, i) => {
    let due = new Date(date);
    if (plan.frequency === "mensual") {
      due = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + i, 1, 12));
      const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
      due.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    } else due.setUTCDate(date.getUTCDate() + i * (plan.frequency === "semanal" ? 7 : 15));
    return { number: i + 1, date: due.toISOString().slice(0, 10), amount: installment + (i === count - 1 ? debt % count : 0) };
  });
  return { initial, principal, surcharge, payable: amount + surcharge, payments };
}
export function validateQuote(raw) {
  if (!raw || !String(raw.companyName || raw.contactName || "").trim()) fail("Indica el cliente o contacto.");
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 100) fail("Agrega entre 1 y 100 líneas.");
  const text = (v, max) => String(v || "").trim().slice(0, max);
  const items = raw.items.map(item => {
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) fail("Cantidad inválida.");
    const unit = money(item.precio, "Precio unitario");
    if (!text(item.concepto, 500)) fail("Cada línea necesita una descripción.");
    return { productId: item.productId == null ? null : String(item.productId), concepto: text(item.concepto, 500), qty, precio: unit / 100, amount: Math.round(qty * unit) };
  });
  const discount = Number(raw.globalDiscountPct || 0);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) fail("Descuento fuera de rango.");
  const gross = items.reduce((sum, i) => sum + i.amount, 0);
  const discountAmount = Math.round(gross * discount / 100);
  const subtotal = gross - discountAmount;
  const tax = raw.applyTax !== false ? Math.round(subtotal * 0.16) : 0;
  const total = subtotal + tax;
  if (total <= 0) fail("El total debe ser mayor que cero.");
  if (raw.total == null || raw.total === "" || !Number.isFinite(Number(raw.total)) || Math.abs(cents(raw.total) - total) > 2) fail("Los importes cambiaron. Revisa el total antes de generar.");
  return { companyName: text(raw.companyName, 250), contactName: text(raw.contactName, 250),
    contactPhone: text(raw.contactPhone, 80), contactEmail: text(raw.contactEmail, 250),
    number: text(raw.number, 80), validUntil: text(raw.validUntil, 10), notes: text(raw.notes, 4000),
    items, gross, discountAmount, subtotal, tax, total, applyTax: raw.applyTax !== false };
}
