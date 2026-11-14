import express from "express";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { isAdministrator, permissionList } from "./secure-access.js";
import { isGenerator, financingSchedule, validateQuote } from "./baifa-sales-rules.js";

export const SALES_DOCUMENTS_PATH = "/api/generators/sales-documents";
const MAX_PDF = 10 * 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/i;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
export const canUseSalesDocuments = user => !!user && !user.isPartner && user.level !== "partner_externo" &&
  (isAdministrator(user) || permissionList(user.moduleAccess).includes("generators-ventas"));
const publicMeta = ({ dataBase64, quote, plan, ...meta }) => meta;

export async function cleanBrief(base64) {
  if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_PDF / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw error("PDF inválido o mayor a 10 MB.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PDF || bytes.subarray(0, 5).toString() !== "%PDF-") throw error("El archivo debe ser un PDF válido de hasta 10 MB.");
  let original;
  try { original = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
  catch { throw error("No se pudo leer el PDF. No se admiten archivos dañados o protegidos por contraseña."); }
  let pages;
  try { pages = original.getPageCount(); } catch { throw error("El PDF está dañado o incompleto."); }
  if (pages < 1 || pages > 60) throw error("El brief debe tener entre 1 y 60 páginas.");
  // Reject active content (including page/annotation actions) rather than relying on MIME.
  for (const [, object] of original.context.enumerateIndirectObjects()) {
    const contents = object.toString();
    if (/\/(?:A|AA|OpenAction|JavaScript|JS|Launch|RichMedia|EmbeddedFiles|EmbeddedFile|AcroForm|XFA|SubmitForm|ImportData|GoToR|GoToE|Rendition|SetOCGState)\b/.test(contents))
      throw error("El PDF contiene acciones o archivos incrustados. Exporta una copia PDF simple.");
  }
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(original, original.getPageIndices());
  copied.forEach(page => doc.addPage(page));
  const result = Buffer.from(await doc.save());
  if (result.length > MAX_PDF) throw error("El PDF procesado excede 10 MB.");
  return { dataBase64: result.toString("base64"), size: result.length, pages };
}

export async function createPackagePdf(quote, plan, briefs, number, now) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Cotización Flash ${number} · Unidad BAIFA`);
  doc.setAuthor("Perplexity Computer");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(.04, .20, .38), gray = rgb(.38, .42, .46);
  let page, y;
  const clean = value => [...String(value ?? "").replace(/[\r\t]/g, " ")].map(c => {
    if (c === "\n") return c;
    try { font.encodeText(c); return c; } catch { return "?"; }
  }).join("");
  const newPage = title => {
    page = doc.addPage([595.28, 841.89]); y = 720;
    page.drawText("UNIDAD BAIFA", { x: 40, y: 797, size: 18, font: bold, color: blue });
    page.drawText(clean(title), { x: 40, y: 773, size: 12, font: bold, color: blue });
    page.drawText(`${number} | ${now.slice(0, 10)} | USD`, { x: 40, y: 755, size: 9, font, color: gray });
    page.drawText("Propuesta comercial. No es una factura fiscal ni una aprobación de crédito.", { x: 40, y: 24, size: 8, font, color: gray });
  };
  const line = (value, strong = false) => {
    const words = clean(value).split(/\s+/); let current = "";
    const rows = [];
    for (const word of words) {
      // Split unbroken names/URLs so they cannot run outside the printable area.
      for (const part of word.match(/.{1,65}/g) || [""]) {
        if (font.widthOfTextAtSize(`${current} ${part}`, 10) > 505) { rows.push(current); current = part; }
        else current += `${current ? " " : ""}${part}`;
      }
    }
    rows.push(current);
    for (const row of rows) {
      if (y < 58) newPage("Cotización Flash · continuación");
      page.drawText(row, { x: 45, y, size: 10, font: strong ? bold : font, color: blue }); y -= 16;
    }
  };
  const box = title => {
    if (y < 100) newPage("Cotización Flash · continuación");
    y -= 12;
    page.drawRectangle({ x: 40, y: y - 7, width: 515, height: 24, color: rgb(.94, .96, .98), borderColor: rgb(.8, .85, .9), borderWidth: .5 });
    line(title, true); y -= 12;
  };
  const usd = cents => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  newPage("Proforma · Cotización Flash");
  box("CLIENTE");
  line(quote.companyName || quote.contactName, true);
  if (quote.companyName && quote.contactName) line(`Contacto: ${quote.contactName}`);
  if (quote.contactPhone) line(`Teléfono: ${quote.contactPhone}`);
  if (quote.contactEmail) line(`Correo: ${quote.contactEmail}`);
  if (quote.number) line(`Referencia de cotización: ${quote.number}`);
  if (quote.validUntil) line(`Válida hasta: ${quote.validUntil}`);
  y -= 10; box("EQUIPOS Y SERVICIOS");
  quote.items.forEach((item, i) => { line(`${i + 1}. ${item.concepto}`, true); line(`Cantidad: ${item.qty}   |   Unitario: ${usd(Math.round(item.precio * 100))}   |   Importe: ${usd(item.amount)}`); y -= 6; });
  box("RESUMEN ECONÓMICO");
  line(`Subtotal bruto: ${usd(quote.gross)}`);
  if (quote.discountAmount) line(`Descuento: -${usd(quote.discountAmount)}`);
  line(`Subtotal neto: ${usd(quote.subtotal)}   |   IVA ${quote.applyTax ? "16%" : "no aplica"}: ${usd(quote.tax)}`);
  line(`TOTAL PROFORMA: ${usd(quote.total)}`, true);
  if (quote.notes) { y -= 12; box("CONDICIONES"); line(quote.notes); }
  y -= 12; box("BRIEFS INCLUIDOS");
  briefs.forEach(b => line(`${b.sku} · ${b.productName} · ${b.filename}`));
  const schedule = financingSchedule(quote.total / 100, plan);
  newPage("Plan de financiamiento / forma de pago");
  box(plan.mode === "contado" ? "PAGO DE CONTADO" : "PROPUESTA DE FINANCIAMIENTO");
  line(`Cliente: ${quote.companyName || quote.contactName}`, true);
  line(`Total proforma: ${usd(quote.total)}`);
  line(`Pago inicial: ${usd(schedule.initial)}`);
  line(`Saldo a financiar: ${usd(schedule.principal)}`);
  line(`Recargo fijo acordado: ${usd(schedule.surcharge)}`);
  line(`Total a pagar (inicial + cuotas): ${usd(schedule.payable)}`, true);
  if (schedule.payments.length) {
    y -= 12; box(`CRONOGRAMA · PERIODICIDAD ${plan.frequency.toUpperCase()}`);
    schedule.payments.forEach(p => line(`Cuota ${p.number}   |   ${p.date}   |   ${usd(p.amount)}`));
    y -= 12;
    line("Cálculo: saldo = total - inicial; cuotas = (saldo + recargo fijo) / número de cuotas. El ajuste de centavos se aplica a la última cuota.");
    line("No se calcula una tasa de interés. Condiciones sujetas a revisión y aprobación comercial.");
  } else line("Pago completo de la proforma; no aplica financiamiento.");
  for (const brief of briefs) {
    const source = await PDFDocument.load(Buffer.from(brief.dataBase64, "base64"));
    const pages = await doc.copyPages(source, source.getPageIndices());
    pages.forEach(p => doc.addPage(p));
  }
  return Buffer.from(await doc.save());
}

export function runPdfWorker(task, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./baifa-sales-pdf-worker.js", import.meta.url), {
      workerData: { task, args }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    const timer = setTimeout(() => { worker.terminate(); reject(error("El PDF excede el tiempo de procesamiento. Exporta una versión más simple.", 422)); }, 20000);
    worker.once("message", result => {
      clearTimeout(timer);
      if (result.error) reject(error(result.error, result.status || 400));
      else resolve(task === "package" ? Buffer.from(result.value) : result.value);
    });
    worker.once("error", () => { clearTimeout(timer); reject(error("El PDF excede los recursos permitidos o está dañado.", 422)); });
    worker.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(error("No se pudo procesar este PDF.", 422)); });
  });
}

export function registerSalesDocumentRoutes(app, { sessions, pool, readCol }) {
  const router = express.Router();
  let working = 0;
  router.use(async (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    try {
      const user = await sessions.authenticate(req);
      if (!user) return res.status(401).json({ message: "Inicia sesión para acceder a los documentos." });
      if (!canUseSalesDocuments(user)) return res.status(403).json({ message: "Requiere acceso a Ventas de Generators." });
      req.salesUser = user; next();
    } catch { res.status(503).json({ message: "No se pudo verificar la sesión." }); }
  });
  router.use(express.json({ limit: "14mb" }));
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : "No se pudo procesar el documento. Intenta nuevamente." }); }
  };
  const save = async (key, value) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(193001)");
      const { rows } = await client.query(`SELECT
        COALESCE(SUM((value->>'size')::bigint),0) AS bytes,
        COUNT(*) FILTER (WHERE value->>'createdBy'=$1 AND updated_at>$2) AS daily
        FROM kv WHERE key LIKE 'baifa.sales.%'`, [String(value.createdBy), Date.now() - 86400000]);
      if (Number(rows[0]?.bytes || 0) + value.size > 1024 * 1024 * 1024 ||
          Number(rows[0]?.daily || 0) >= 100) throw error("Se alcanzó el límite de documentos (100 al día por usuario / 1 GB total). Contacta al administrador.", 429);
      await client.query("INSERT INTO kv(key,value,updated_at) VALUES($1,$2::jsonb,$3)", [key, JSON.stringify(value), Date.now()]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  };
  const load = async (kind, id) => {
    if (!UUID.test(id || "")) throw error("Documento no encontrado.", 404);
    const result = await pool.query("SELECT value FROM kv WHERE key=$1", [`baifa.sales.${kind}:${id}`]);
    if (!result.rows[0]) throw error("Documento no encontrado.", 404);
    return result.rows[0].value;
  };
  for (const [route, kind] of [["briefs", "brief"], ["packages", "package"]]) {
    router.get(`/${route}`, handle(async (_req, res) => {
      const rows = await pool.query("SELECT value - 'dataBase64' - 'quote' - 'plan' AS value FROM kv WHERE key LIKE $1 ORDER BY updated_at DESC LIMIT 500", [`baifa.sales.${kind}:%`]);
      res.json(rows.rows.map(r => publicMeta(r.value)));
    }));
    router.get(`/${route}/:id/download`, handle(async (req, res) => {
      const value = await load(kind, req.params.id);
      res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${encodeURIComponent(value.filename)}"`, "Content-Security-Policy": "sandbox" });
      res.send(Buffer.from(value.dataBase64, "base64"));
    }));
  }
  const expensive = fn => handle(async (req, res) => {
    if (working >= 2) throw error("Hay documentos en proceso. Intenta nuevamente en unos segundos.", 429);
    working++;
    try { await fn(req, res); } finally { working--; }
  });
  router.post("/briefs", expensive(async (req, res) => {
    const { productId, filename, dataBase64 } = req.body || {};
    if (typeof filename !== "string" || !/\.pdf$/i.test(filename) || filename.length > 180) throw error("Selecciona un archivo .pdf.");
    const products = await readCol("erpProducts");
    const product = products.find(p => String(p.id) === String(productId));
    if (!product || !isGenerator(product)) throw error("Selecciona un grupo electrógeno BAIFA del catálogo.");
    const sku = String(product.code || product.sku || "").trim();
    if (!sku) throw error("El equipo necesita un código de catálogo.");
    const pdf = await runPdfWorker("brief", [dataBase64]);
    const doc = { id: randomUUID(), productId: String(product.id), sku, productName: String(product.name || "").slice(0, 300),
      filename: filename.replace(/[\/\\\x00-\x1f\x7f"]/g, "_"), ...pdf, createdAt: new Date().toISOString(), createdBy: req.salesUser.id };
    await save(`baifa.sales.brief:${doc.id}`, doc);
    res.status(201).json(publicMeta(doc));
  }));
  router.post("/packages", expensive(async (req, res) => {
    const quote = validateQuote(req.body?.quote);
    const inputPlan = req.body?.plan;
    const plan = inputPlan?.mode === "contado" ? { mode: "contado" } : {
      mode: inputPlan?.mode, initial: inputPlan?.initial, surcharge: inputPlan?.surcharge,
      count: inputPlan?.count, frequency: inputPlan?.frequency, firstDate: inputPlan?.firstDate,
    };
    const checkedPlan = financingSchedule(quote.total / 100, plan);
    if (plan.mode === "financiado") {
      plan.initial = checkedPlan.initial / 100;
      plan.surcharge = checkedPlan.surcharge / 100;
      plan.count = Number(plan.count);
      plan.frequency = String(plan.frequency);
      plan.firstDate = String(plan.firstDate);
    }
    const ids = req.body?.briefIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 15 || new Set(ids).size !== ids.length) throw error("Selecciona entre 1 y 15 briefs distintos.");
    const briefs = await Promise.all(ids.map(id => load("brief", id)));
    if (briefs.reduce((s, b) => s + b.size, 0) > 25 * 1024 * 1024 || briefs.reduce((s, b) => s + b.pages, 0) > 180)
      throw error("Los briefs juntos exceden 25 MB o 180 páginas. Divide la cotización.");
    const products = await readCol("erpProducts");
    const quoted = products.filter(p => isGenerator(p) && quote.items.some(i => i.productId === String(p.id)));
    if (!quoted.length) throw error("Agrega al menos un grupo electrógeno del catálogo a la cotización.");
    if (quoted.some(p => !briefs.some(b => b.productId === String(p.id))) ||
        briefs.some(b => !quoted.some(p => b.productId === String(p.id))) ||
        new Set(briefs.map(b => b.productId)).size !== briefs.length) throw error("Incluye exactamente un brief por modelo cotizado.");
    const id = randomUUID(), now = new Date().toISOString();
    const number = `FLASH-${now.slice(0, 10).replaceAll("-", "")}-${id.slice(0, 8).toUpperCase()}`;
    const bytes = await runPdfWorker("package", [quote, plan, briefs, number, now]);
    if (bytes.length > 30 * 1024 * 1024) throw error("La cotización excede 30 MB.");
    const record = { id, number, filename: `${number}.pdf`, companyName: quote.companyName || quote.contactName, total: quote.total / 100,
      createdAt: now, createdBy: req.salesUser.id, briefIds: ids, quote, plan, size: bytes.length, dataBase64: bytes.toString("base64") };
    await save(`baifa.sales.package:${id}`, record);
    res.status(201).json(publicMeta(record));
  }));
  router.use((err, _req, res, _next) => res.status(err.status === 413 ? 413 : 400).json({ message: "Solicitud inválida o demasiado grande (máximo 10 MB por PDF)." }));
  app.use(SALES_DOCUMENTS_PATH, router);
}
