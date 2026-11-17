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
  const amortized = plan.method === "amortizacion_mensual";
  if (plan.method != null && !["amortizacion_mensual", "recargo_fijo"].includes(plan.method)) fail("Método de financiamiento inválido.");
  if (amortized && (Number(plan.annualRate) !== 24 || plan.frequency !== "mensual"))
    fail("Este plan requiere tasa nominal anual de 24% y cuotas mensuales.");
  if (amortized && plan.surcharge != null && plan.surcharge !== "" && Number(plan.surcharge) !== 0)
    fail("El plan al 24% no admite un recargo fijo adicional.");
  const initial = money(plan.initial, "Inicial");
  const surcharge = amortized ? 0 : money(plan.surcharge, "Recargo fijo acordado");
  const count = Number(plan.count);
  if (initial >= amount) fail("La inicial debe ser menor que el total para financiar.");
  if (!Number.isInteger(count) || count < 1 || count > 60) fail("Indica entre 1 y 60 cuotas.");
  if (!["mensual", "quincenal", "semanal"].includes(plan.frequency)) fail("Selecciona la periodicidad.");
  if (!/^(20\d{2})-\d{2}-\d{2}$/.test(plan.firstDate || "")) fail("Indica una primera cuota entre 2000 y 2099.");
  const date = new Date(`${plan.firstDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== plan.firstDate) fail("Fecha de primera cuota inválida.");
  const principal = amount - initial;
  const dueDate = i => {
    let due = new Date(date);
    if (plan.frequency === "mensual") {
      due = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + i, 1, 12));
      const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
      due.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    } else due.setUTCDate(date.getUTCDate() + i * (plan.frequency === "semanal" ? 7 : 15));
    return due.toISOString().slice(0, 10);
  };
  if (amortized) {
    // All balances are integer cents. Nominal annual 24% / 12 = 2% per month.
    const rate = 0.02;
    const installment = Math.round(principal * rate / (1 - Math.pow(1 + rate, -count)));
    let balance = principal;
    const payments = Array.from({ length: count }, (_, i) => {
      const interest = Math.round(balance * rate);
      const capital = i === count - 1 ? balance : installment - interest;
      if (capital <= 0 || capital > balance || (i < count - 1 && capital === balance))
        fail("Saldo demasiado pequeño para ese plazo. Reduce el número de cuotas.");
      balance -= capital;
      return { number: i + 1, date: dueDate(i), amount: capital + interest, capital, interest, balance };
    });
    const interest = payments.reduce((sum, p) => sum + p.interest, 0);
    return { method: plan.method, annualRate: 24, monthlyRate: 2, initial, principal, surcharge: 0,
      interest, installment, payable: amount + interest, payments };
  }
  const debt = principal + surcharge;
  const installment = Math.floor(debt / count);
  const payments = Array.from({ length: count }, (_, i) => {
    return { number: i + 1, date: dueDate(i), amount: installment + (i === count - 1 ? debt % count : 0) };
  });
  return { initial, principal, surcharge, payable: amount + surcharge, payments };
}
export function validateQuote(raw) {
  if (!raw || !String(raw.companyName || raw.contactName || "").trim()) fail("Indica el cliente o contacto.");
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 100) fail("Agrega entre 1 y 100 líneas.");
  const text = (v, max) => String(v || "").trim().slice(0, max);
  // Cap raw text before splitting so huge payloads cannot cost CPU/memory on the main thread.
  const rawText = (v, max) => String(v || "").slice(0, max);
  const lines = v => rawText(v, 8000).split(/\r?\n/).map(s => s.trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  const items = raw.items.map(item => {
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) fail("Cantidad inválida.");
    const unit = money(item.precio, "Precio unitario");
    if (!text(item.concepto, 500)) fail("Cada línea necesita una descripción.");
    // Optional execution detail printed as an annex (one step per line, max 40 steps).
    const detalle = [...new Set(rawText(item.detalle, 24000).split(/\r?\n/).map(s => s.trim().slice(0, 300)).filter(Boolean))].slice(0, 40);
    return { productId: item.productId == null ? null : String(item.productId), concepto: text(item.concepto, 500), qty, precio: unit / 100, amount: Math.round(qty * unit),
      serviceItem: item.serviceItem === true, detalle };
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
    city: text(raw.city, 80), state: text(raw.state, 80),
    conditions: lines(raw.conditions), complements: lines(raw.complements),
    items, gross, discountAmount, subtotal, tax, total, applyTax: raw.applyTax !== false };
}
