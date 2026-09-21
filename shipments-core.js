import { createHash, randomUUID } from "node:crypto";
import XLSX from "xlsx";

export const SHIPMENT_KEY = "generatorsShipments";
export const STAGES = ["Por definir", "En producción", "Almacén China", "Embarcando", "En tránsito", "Transbordo", "En puerto", "Almacén local"];
export const STATUSES = ["Por confirmar", "Disponible", "Vendido", "Alquilado", "En revisión técnica", "Reservado"];
export const text = (v) => v == null ? "" : String(v).trim();
const norm = (v) => text(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function emptyState() { return { items: [], imports: [], notes: [], revision: 0 }; }
export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
export function accessFor(user) {
  let modules = user?.moduleAccess || [];
  try { if (typeof modules === "string") modules = JSON.parse(modules); } catch { modules = []; }
  if (!Array.isArray(modules)) modules = [];
  const admin = user?.level === "ceo" || user?.username === "admin";
  const write = admin || modules.includes("generators-embarques") || modules.includes("generators-compras") || modules.includes("generators-inventario");
  return { read: write || modules.includes("generators-ventas"), write };
}
export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateItem(input) {
  if (!input || typeof input !== "object") throw httpError(400, "Registro inválido.");
  const out = {};
  for (const key of ["orderId", "shipmentName", "model", "modality", "stage", "commercialStatus", "bl", "carrier", "eta", "etaNote", "destination", "client", "serial", "notes"]) {
    out[key] = text(input[key]);
    if (out[key].length > (key === "notes" ? 4000 : 300)) throw httpError(400, `El campo ${key} excede el tamaño permitido.`);
  }
  out.quantity = Number(input.quantity);
  if (!out.model) throw httpError(400, "El modelo es obligatorio.");
  if (!Number.isSafeInteger(out.quantity) || out.quantity < 1 || out.quantity > 100000) throw httpError(400, "La cantidad debe ser un entero positivo.");
  if (!STAGES.includes(out.stage)) throw httpError(400, "Etapa logística inválida.");
  if (!STATUSES.includes(out.commercialStatus)) throw httpError(400, "Estado comercial inválido.");
  if (out.eta && !validDate(out.eta)) throw httpError(400, "La ETA debe ser una fecha válida.");
  if (out.serial && out.quantity !== 1) throw httpError(400, "Un serial identifica un solo equipo. Separe las unidades antes de asignar serial.");
  return out;
}
export function reviewFlags(item, today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" })) {
  const flags = [];
  if (item.stage === "Por definir") flags.push("Etapa logística por confirmar");
  if (item.commercialStatus === "Por confirmar") flags.push("Estado comercial por confirmar");
  if (item.eta && item.eta < today && ["En producción", "Almacén China", "Embarcando", "En tránsito", "Transbordo"].includes(item.stage)) flags.push("ETA vencida: verificar llegada o fecha");
  if (["Embarcando", "En tránsito", "Transbordo", "En puerto"].includes(item.stage) && !item.bl) flags.push("Falta BL / documento");
  if (item.stage === "Almacén local" && !item.serial) flags.push("Falta serial en almacén local");
  if (item.source && item.version === 1) flags.push(...(item.source.warnings || []));
  return [...new Set(flags)];
}

function mapRow(values, rowNumber, sheetName) {
  const [orderId, shipmentName, model, quantity, modality, rawStage, bl, carrier, rawEta, destination, rawClient, serial] = values;
  const stageText = norm(rawStage), clientText = norm(rawClient), modalityText = norm(modality);
  let stage = "Por definir", commercialStatus = "Por confirmar";
  const warnings = [];
  if (/produccion|fabricacion/.test(stageText)) stage = "En producción";
  else if (/almacen china/.test(stageText)) stage = "Almacén China";
  else if (/transbordo/.test(stageText)) stage = "Transbordo";
  else if (/embarcando/.test(stageText)) stage = "Embarcando";
  else if (/transito|navegacion/.test(stageText)) stage = "En tránsito";
  else if (/puerto/.test(stageText)) stage = "En puerto";
  else if (/local/.test(stageText)) stage = "Almacén local";
  if (stage === "Por definir") {
    if (/en puerto/.test(clientText)) stage = "En puerto";
    else if (/en navegacion/.test(clientText)) stage = "En tránsito";
    else if (norm(rawEta) === "llego") stage = "Almacén local";
  }
  if (/vendid/.test(stageText) || /vendid/.test(modalityText)) commercialStatus = "Vendido";
  else if (/alquilad/.test(stageText) || /alquilad/.test(clientText)) commercialStatus = "Alquilado";
  else if (/revision/.test(stageText)) commercialStatus = "En revisión técnica";
  else if (/disponible/.test(stageText)) commercialStatus = "Disponible";
  if (/produccion/.test(clientText) && stage === "Almacén China") warnings.push("Excel indica Almacén China y EN PRODUCCIÓN: confirmar etapa");
  if (/navegacion/.test(clientText) && stage === "En puerto") warnings.push("Excel indica En puerto y En navegación: confirmar etapa");
  let eta = "", etaNote = "";
  if (rawEta instanceof Date) eta = rawEta.toISOString().slice(0, 10);
  else if (typeof rawEta === "number") {
    const d = XLSX.SSF.parse_date_code(rawEta);
    if (d) eta = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  } else if (validDate(text(rawEta))) eta = text(rawEta);
  else etaNote = text(rawEta);
  const clientIsStatus = /^(en puerto|en navegacion|por embarcar|en produccion|alquilada)$/.test(clientText);
  const sourceValues = values.slice(0, 12).map(v => v instanceof Date ? v.toISOString().slice(0, 10) : text(v));
  const clean = (v) => text(v) === "-" ? "" : text(v);
  const record = validateItem({
    orderId: clean(orderId), shipmentName: clean(shipmentName), model: clean(model),
    quantity: Number(quantity), modality: clean(modality), stage, commercialStatus,
    bl: clean(bl), carrier: clean(carrier), eta, etaNote: clean(etaNote),
    destination: clean(destination), client: clientIsStatus ? "" : clean(rawClient),
    serial: clean(serial), notes: clientIsStatus ? `Estado original: ${text(rawClient)}` : "",
  });
  // La fila forma parte de la identidad: dos equipos pueden tener filas idénticas
  // y ambos deben conservarse, mientras reimportar el mismo archivo sigue siendo idempotente.
  const fingerprint = createHash("sha256").update(JSON.stringify([sheetName, rowNumber, sourceValues])).digest("hex");
  return { ...record, source: { type: "xlsx", sheet: sheetName, row: rowNumber, values: sourceValues, fingerprint, warnings } };
}

export function parseWorkbook(buffer) {
  let workbook;
  try { workbook = XLSX.read(buffer, { type: "buffer", cellDates: true }); }
  catch { throw httpError(400, "No se pudo leer el archivo Excel."); }
  if (!workbook.SheetNames.length) throw httpError(400, "El archivo no contiene hojas.");
  const sheetName = workbook.SheetNames.find(n => norm(n).includes("seguimiento")) || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: true });
  const headerIndex = rows.findIndex(row => norm(row[0]).includes("id pedido") && norm(row[2]).includes("modelo"));
  if (headerIndex < 0) throw httpError(400, "No se encontró la tabla esperada (ID Pedido, Modelo / kVA, Cantidad).");
  const records = [], errors = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!text(row[2])) continue;
    if (norm(row[0]).includes("total unidades")) break;
    try { records.push(mapRow(row, i + 1, sheetName)); }
    catch (e) { errors.push({ row: i + 1, message: e.message }); }
  }
  if (!records.length) throw httpError(400, "El archivo no contiene filas válidas para importar.");
  return { sheetName, records, errors };
}

export function importWorkbook(state, parsed, meta) {
  const current = structuredClone(state || emptyState());
  const byFingerprint = new Map(current.items.map(x => [x.source?.fingerprint, x]));
  let added = 0, duplicates = 0;
  for (const record of parsed.records) {
    if (byFingerprint.has(record.source.fingerprint)) { duplicates++; continue; }
    const now = new Date().toISOString();
    const item = { id: randomUUID(), ...record, version: 1, createdAt: now, updatedAt: now, createdBy: meta.userId, updatedBy: meta.userId };
    current.items.push(item); byFingerprint.set(record.source.fingerprint, item); added++;
  }
  current.revision = Number(current.revision || 0) + 1;
  current.imports.unshift({ id: randomUUID(), fileName: meta.fileName, sheet: parsed.sheetName, rowsFound: parsed.records.length, added, duplicates, errors: parsed.errors, importedAt: new Date().toISOString(), importedBy: meta.userId, importedByName: meta.userName });
  current.imports = current.imports.slice(0, 50);
  return { state: current, result: { rowsFound: parsed.records.length, added, duplicates, errors: parsed.errors.length } };
}

export function createItem(state, input, meta) {
  const current = structuredClone(state || emptyState()), clean = validateItem(input), now = new Date().toISOString();
  const item = { id: randomUUID(), ...clean, version: 1, createdAt: now, updatedAt: now, createdBy: meta.userId, updatedBy: meta.userId, source: { type: "manual" } };
  current.items.push(item); current.revision = Number(current.revision || 0) + 1;
  return { state: current, item };
}
export function updateItem(state, id, input, expectedVersion, meta) {
  const current = structuredClone(state || emptyState());
  const index = current.items.findIndex(x => x.id === id);
  if (index < 0) throw httpError(404, "Embarque no encontrado.");
  if (Number(expectedVersion) !== Number(current.items[index].version)) throw httpError(409, "Este registro fue actualizado por otra persona. Recargue antes de guardar.");
  const before = current.items[index], clean = validateItem(input), now = new Date().toISOString();
  const changes = {};
  for (const key of Object.keys(clean)) if (clean[key] !== before[key]) changes[key] = { from: before[key], to: clean[key] };
  if (!Object.keys(changes).length) return { state: current, item: before };
  const item = { ...before, ...clean, version: before.version + 1, updatedAt: now, updatedBy: meta.userId };
  current.items[index] = item;
  current.notes.unshift({ id: randomUUID(), itemId: id, changes, changedAt: now, changedBy: meta.userId, changedByName: meta.userName });
  current.notes = current.notes.slice(0, 5000); current.revision = Number(current.revision || 0) + 1;
  return { state: current, item };
}

export function publicState(state, canWrite) {
  const current = state || emptyState();
  return {
    ok: true, canWrite, revision: current.revision || 0,
    items: (current.items || []).map(item => ({ ...item, reviewFlags: reviewFlags(item) })),
    imports: current.imports || [], notes: current.notes || [],
  };
}
