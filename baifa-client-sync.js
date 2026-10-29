import { createHash, randomBytes } from "node:crypto";
import {CLIENT_LOCK} from "./client-collection-transactions.js";

export const SINCE = "2022-01-01";
export const POLICY_VERSION = "rif-consolidation-2026-10-29";
const norm = v => String(v || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
const tax = v => norm(v).replace(/[^A-Z0-9]/g, "");
const idOf = v => Array.isArray(v) ? Number(v[0]) : Number(v);
const clean = v => typeof v === "string" ? v.trim() : "";
export const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isBaifaSyncPath = path => /^\/api\/generators\/clients\/odoo-baifa(?:\/|$)/i.test(path);

export function isGenerator(p) {
  const name = norm(p.name).trim();
  const title = name.replace(/^\[[^\]]{1,100}\]\s*/, "").split(/\/\/|\|/)[0];
  const scopeText = name.replace(/\bINCLUYE\s+\d+\s*HRS\s+DE\s+PIEZAS\s+DE\s+MANTENIMIENTO\b/g, "");
  const brand = norm(`${p.x_studio_marca || ""} ${p.x_studio_marca_1 || ""} ${p.name || ""}`);
  // Verified in Odoo: legacy category 60 and current category 3439 both carry
  // this category name. Full sets mention ATS and oil capacity in specifications;
  // those words must not classify an entire generator as a spare part.
  const category = tax(Array.isArray(p.categ_id) ? p.categ_id[1] : "");
  return /\bBAIFA\b/.test(brand) && p.type !== "service" &&
    category === "GENERADORESELECTRICOS" &&
    /^(?:GENERADOR(?:ES)?|GENERATOR|GENSET|GRUPO ELECTROGENO|PLANTA ELECTRICA)\b/.test(title) &&
    !/\b(?:REPUESTOS?|MANTENIMIENTO|SERVICIOS?|ALQUILER|ARRENDAMIENTO)\b/.test(scopeText);
}

// Identity is evidenced by explicit Odoo fiscal text, not a fuzzy name match or
// an assertion of verification against a government registry.
export function fiscalIdentity(p) {
  const vat = tax(p.vat);
  const suffix = norm(p.name).match(/\b([JGVEP])[\s-]*(\d(?:[\s-]*\d){8})\s*$/);
  const nameRif = suffix ? tax(suffix[0]) : "";
  const valid = v => /^[JGVEP]\d{9}$/.test(v);
  let rif = valid(vat) ? vat : "";
  if (vat && !rif && !(nameRif && /^\d{9}$/.test(vat) && nameRif.slice(1) === vat))
    return {reason: "Campo fiscal incompleto o no reconocido", vat, nameRif};
  if (rif && nameRif && rif !== nameRif)
    return {reason: "El RIF fiscal y el de la razón social no coinciden", vat, nameRif};
  rif ||= nameRif;
  return rif ? {rif, vat, nameRif, basis: valid(vat) ? "odoo-vat" : vat ? "odoo-vat-and-legal-name" : "odoo-legal-name"}
    : {reason: "Sin RIF explícito suficiente en Odoo", vat, nameRif};
}

export function consolidateCustomers(customers) {
  const groups = new Map(), pending = [], excluded = [];
  for (const customer of customers) {
    const p = customer.partner;
    if (/^USOINTERNOCOPIKON(?:VENEZUELA)?CA(?:J294654568)?$/.test(tax(p.name))) {
      excluded.push({odooId: p.id, name: p.name, reason: "Uso interno excluido por autorización"}); continue;
    }
    const identity = fiscalIdentity(p);
    if (!identity.rif) {
      pending.push({odooId: p.id, name: p.name, ...identity}); continue;
    }
    if (!groups.has(identity.rif)) groups.set(identity.rif, []);
    groups.get(identity.rif).push({...customer, identity});
  }
  const merged = [...groups.entries()].map(([rif, members]) => {
    members.sort((a, b) => Number(a.partner.id) - Number(b.partner.id));
    const uniqueLines = key => [...new Map(members.flatMap(c => c[key]).map(line =>
      [`${line.companyId}:${line.invoiceId}:${line.lineId}`, line])).values()];
    return {
      partner: structuredClone(members.at(-1).partner), rif,
      partnerIds: members.map(c => Number(c.partner.id)),
      identityEvidence: members.map(c => ({odooId: c.partner.id, name: c.partner.name, ...c.identity})),
      sales: uniqueLines("sales"), credits: uniqueLines("credits"),
    };
  });
  return {customers: merged.filter(c => c.sales.some(s => s.quantity > 0)), pending, excluded};
}

async function all(odoo, model, domain, fields, maximum = 50000, context = {}) {
  const rows = [];
  for (let offset = 0; offset <= maximum; offset += 500) {
    const batch = await odoo.searchRead(model, domain, fields, {offset, limit: 500, order: "id asc", context: {...context, active_test: false}});
    if (!Array.isArray(batch)) throw Error(`Respuesta no válida de ${model}`);
    rows.push(...batch);
    if (rows.length > maximum) throw Error(`El histórico de ${model} supera el límite seguro; no se importó una lista parcial.`);
    if (batch.length < 500) return rows;
  }
  throw Error("Consulta incompleta");
}

async function byIds(odoo, model, ids, fields, context = {}) {
  const result = [];
  const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0);
  for (let i = 0; i < unique.length; i += 300)
    result.push(...await all(odoo, model, [["id", "in", unique.slice(i, i + 300)]], fields, 50000, context));
  if (result.length !== unique.length) throw Error(`No se pudo leer todo el conjunto de ${model}; no se importará información parcial.`);
  return result;
}

export async function loadBaifaCustomers(odoo) {
  if (!odoo.isConfigured()) throw Error("Odoo no está configurado en el servidor.");
  const companies = (await all(odoo, "res.company", [], ["id", "name", "vat"], 100))
    .filter(c => tax(c.vat) === "J294654568" && /^(?:COPIKONCA|COPIKONVENEZUELACA)(?:J294654568)?$/.test(tax(c.name)));
  if (!companies.length) throw Error("No se pudo identificar la compañía Copikon en Odoo.");
  const context = {allowed_company_ids: companies.map(c => c.id)};
  const until = new Intl.DateTimeFormat("en-CA", {timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  const fields = await odoo.execute("product.product", "fields_get", [], {attributes: ["type"]});
  const brandFields = ["x_studio_marca", "x_studio_marca_1"].filter(f => fields[f]);
  const clauses = [["name", "ilike", "BAIFA"], ...brandFields.map(f => [f, "ilike", "BAIFA"])];
  const domain = [...Array(clauses.length - 1).fill("|"), ...clauses];
  const products = await all(odoo, "product.product", domain, ["id", "name", "default_code", "type", "categ_id", ...brandFields], 50000, context);
  const included = products.filter(isGenerator);
  if (!included.length) throw Error("No se identificaron generadores BAIFA; revisa la clasificación antes de importar.");
  const lines = await all(odoo, "account.move.line", [
    ["company_id", "in", companies.map(c => c.id)],
    ["move_id.state", "=", "posted"], ["move_id.move_type", "in", ["out_invoice", "out_refund"]],
    ["move_id.invoice_date", ">=", SINCE], ["move_id.invoice_date", "<=", until], ["product_id", "in", included.map(p => p.id)],
  ], ["id", "move_id", "product_id", "quantity"], 50000, context);
  const moves = await byIds(odoo, "account.move", lines.map(l => idOf(l.move_id)),
    ["id", "name", "invoice_date", "move_type", "state", "partner_id", "commercial_partner_id", "company_id"], context);
  const moveMap = new Map(moves.map(m => [m.id, m]));
  const partnerIds = moves.map(m => idOf(m.commercial_partner_id) || idOf(m.partner_id));
  const partners = await byIds(odoo, "res.partner", partnerIds,
    ["id", "name", "vat", "ref", "phone", "mobile", "email", "street", "street2", "city", "state_id"], context);
  const partnerMap = new Map(partners.map(p => [p.id, p]));
  const grouped = new Map();
  for (const line of lines) {
    const move = moveMap.get(idOf(line.move_id));
    if (!move || move.state !== "posted" || typeof move.invoice_date !== "string" ||
        move.invoice_date < SINCE || move.invoice_date > until ||
        !["out_invoice", "out_refund"].includes(move.move_type) ||
        !context.allowed_company_ids.includes(idOf(move.company_id)) ||
        !included.some(p => p.id === idOf(line.product_id)))
      throw Error("Documento fuera del alcance esperado.");
    const partnerId = idOf(move.commercial_partner_id) || idOf(move.partner_id);
    const p = partnerMap.get(partnerId);
    if (!p || !clean(p.name)) throw Error("Cliente sin ficha legible en Odoo.");
    if (!grouped.has(partnerId)) grouped.set(partnerId, {partner: p, sales: [], credits: []});
    const item = {invoiceId: move.id, invoice: move.name, date: move.invoice_date, companyId: idOf(move.company_id),
      lineId: line.id, productId: idOf(line.product_id), product: line.product_id?.[1] || "", quantity: Number(line.quantity) || 0};
    grouped.get(partnerId)[move.move_type === "out_refund" ? "credits" : "sales"].push(item);
  }
  return {
    since: SINCE, observedAt: new Date().toISOString(), companies,
    products: included.map(p => ({id: p.id, name: p.name, sku: p.default_code || ""})),
    excludedProducts: products.filter(p => !isGenerator(p)).map(p => ({id: p.id, name: p.name})),
    customers: [...grouped.values()],
    invoiceCount: moves.filter(m => m.move_type === "out_invoice").length,
    creditNoteCount: moves.filter(m => m.move_type === "out_refund").length,
  };
}

export function buildPlan(existing, source, reservedIds = []) {
  const consolidated = consolidateCustomers(source.customers);
  const next = structuredClone(existing);
  let nextId = Math.max(0, ...existing.map(c => Number(c.id) || 0), ...reservedIds.map(Number).filter(Number.isFinite)) + 1;
  const actions = [], conflicts = [];
  for (const customer of consolidated.customers) {
    const p = customer.partner;
    const exact = next.filter(c => customer.partnerIds.includes(Number(c.odooId)));
    const rif = customer.rif;
    const byRif = rif ? next.filter(c => tax(c.rif) === rif) : [];
    if (exact.length > 1 || byRif.length > 1 || (exact.length && byRif.some(c => c.id !== exact[0].id)) ||
        exact.some(c => tax(c.rif) && tax(c.rif) !== rif) ||
        (!exact.length && byRif.some(c => c.odooId && !customer.partnerIds.includes(Number(c.odooId))))) {
      conflicts.push({odooId: p.id, name: p.name, reason: "Identificador Odoo o RIF ambiguo"}); continue;
    }
    const current = exact[0] || byRif[0];
    const record = current || {id: nextId++, name: clean(p.name), status: "activo", createdAt: source.observedAt};
    const proposed = {name: p.name, rif, phone: p.phone || p.mobile, email: p.email,
      address: [p.street, p.street2].filter(Boolean).join(", "), city: p.city, state: p.state_id?.[1]};
    // Preserve entered local fields. Only fill blanks; do not infer classifications, regions or sellers.
    for (const [key, value] of Object.entries(proposed)) if (!clean(record[key]) && clean(value)) record[key] = clean(value);
    record.odooId = current?.odooId || p.id;
    record.odooRef = clean(p.ref);
    record.syncStatus = "synced";
    record.lastSyncAt = source.observedAt;
    record.odooBaifaSales = JSON.stringify({
      policyVersion: POLICY_VERSION,
      since: SINCE, observedAt: source.observedAt, invoiceCount: new Set(customer.sales.map(s => s.invoiceId)).size,
      sales: customer.sales, credits: customer.credits,
      rif, sourcePartnerIds: customer.partnerIds, identityEvidence: customer.identityEvidence,
    });
    if (!current) next.push(record);
    actions.push({id: record.id, odooId: p.id, name: record.name, action: current ? "actualizar" : "crear",
      rif, sourcePartnerIds: customer.partnerIds, identityEvidence: customer.identityEvidence,
      invoiceCount: new Set(customer.sales.map(s => s.invoiceId)).size});
  }
  return {next, actions, conflicts, pending: consolidated.pending, excludedCustomers: consolidated.excluded,
    consolidatedGroups: consolidated.customers.filter(c => c.partnerIds.length > 1).length,
    created: actions.filter(a => a.action === "crear").length,
    updated: actions.filter(a => a.action === "actualizar").length};
}

export function registerBaifaClientSync(app, {odoo, readCol, pool, wrap}) {
  const previews = new Map();
  let loading = false;
  const root = "/api/generators/clients/odoo-baifa";
  app.get(root + "/preview", wrap(async (req, res) => {
    if (loading) return res.status(409).json({message: "Ya hay una consulta de Odoo en curso."});
    loading = true;
    try {
      for (const [key, p] of previews) if (p.expires < Date.now()) previews.delete(key);
      if (previews.size >= 20) return res.status(429).json({message: "Demasiadas consultas pendientes."});
      const source = await loadBaifaCustomers(odoo);
      const clients = await readCol("erpClients");
      const equipment = await readCol("erpClientEquipment");
      const plan = buildPlan(clients, source, equipment.map(e => e.clientId));
      const token = randomBytes(24).toString("hex");
      previews.set(token, {owner: String(req.verifiedUser.id), expires: Date.now() + 15 * 60 * 1000,
        beforeHash: fingerprint(clients), equipmentHash: fingerprint(equipment), plan, source});
      res.json({ok: true, previewToken: token, since: SINCE, observedAt: source.observedAt,
        policyVersion: POLICY_VERSION, pending: plan.pending, excludedCustomers: plan.excludedCustomers,
        consolidatedGroups: plan.consolidatedGroups,
        companies: source.companies, products: source.products, excludedProducts: source.excludedProducts,
        invoiceCount: source.invoiceCount, creditNoteCount: source.creditNoteCount,
        customers: plan.actions, conflicts: plan.conflicts, created: plan.created, updated: plan.updated});
    } catch (e) {
      console.error("[baifa-client-preview]", e.message);
      res.status(502).json({message: "No se completó la consulta de Odoo. No se guardó ningún cliente."});
    } finally { loading = false; }
  }));
  app.post(root + "/import", wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.previewToken !== "string" || !/^[a-f0-9]{48}$/.test(body.previewToken))
      return res.status(400).json({message: "Se requiere una vista previa válida."});
    const entry = previews.get(body.previewToken);
    if (!entry || entry.owner !== String(req.verifiedUser.id) || entry.expires < Date.now())
      return res.status(409).json({message: "La vista previa venció. Consulta Odoo nuevamente."});
    if (entry.busy) return res.status(409).json({message: "Esta importación ya se está procesando."});
    if (entry.result) return res.json(entry.result);
    if (entry.plan.conflicts.length) return res.status(409).json({message: "Resuelve las coincidencias ambiguas antes de importar."});
    entry.busy = true;
    let db;
    try {
      db = await pool.connect();
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [CLIENT_LOCK]);
      const current = await db.query("SELECT value FROM kv WHERE key = $1 FOR UPDATE", ["erpClients"]);
      const before = current.rows[0]?.value || [];
      const equipment = await db.query("SELECT value FROM kv WHERE key = $1", ["erpClientEquipment"]);
      if (fingerprint(before) !== entry.beforeHash || fingerprint(equipment.rows[0]?.value || []) !== entry.equipmentHash) {
        await db.query("ROLLBACK");
        return res.status(409).json({message: "Los clientes o equipos cambiaron desde la vista previa. Consulta Odoo nuevamente."});
      }
      const write = (key, value) => db.query(
        "INSERT INTO kv (key,value,updated_at) VALUES ($1,$2::jsonb,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at",
        [key, JSON.stringify(value), Date.now()]);
      const backupKey = "baifaClientSyncBackup:" + body.previewToken;
      await write(backupKey, {at: new Date().toISOString(), by: req.verifiedUser.id, clients: before});
      await write("erpClients", entry.plan.next);
      const result = {ok: true, created: entry.plan.created, updated: entry.plan.updated,
        policyVersion: POLICY_VERSION,
        pending: entry.plan.pending, excludedCustomers: entry.plan.excludedCustomers,
        consolidatedGroups: entry.plan.consolidatedGroups,
        total: entry.plan.next.length, imported: entry.plan.actions.length, since: SINCE, syncedAt: new Date().toISOString()};
      await write("baifaClientSyncLastRun", {...result, by: req.verifiedUser.id, backupKey});
      await db.query("COMMIT");
      entry.result = result;
      res.json(result);
    } catch (e) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { db?.release(); entry.busy = false; }
  }));
}
