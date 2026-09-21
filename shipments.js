import { accessFor, createItem, emptyState, httpError, importWorkbook, parseWorkbook, publicState, SHIPMENT_KEY, updateItem } from "./shipments-core.js";
import { readFile } from "node:fs/promises";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
async function kvGet(pool, key, fallback) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
async function kvSet(pool, key, value) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()],
  );
}
async function getState(pool) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [SHIPMENT_KEY]);
  if (r.rows[0]) return r.rows[0].value;
  const seedPath = new URL("./seeds/seguimiento-stock-generadores.xlsx", import.meta.url);
  const parsed = parseWorkbook(await readFile(seedPath));
  const seeded = importWorkbook(emptyState(), parsed, {
    userId: 1, userName: "Carga inicial", fileName: "Seguimiento-de-Stock-de-Generadores.xlsx",
  }).state;
  await kvSet(pool, SHIPMENT_KEY, seeded);
  return seeded;
}
function resolveUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/, "");
  const match = token.match(/^srv-(\d+)-/);
  if (!match) throw httpError(401, "Sesión requerida.");
  return Number(match[1]);
}
function userName(user) { return `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || user?.username || "Usuario"; }

// Todas las operaciones del módulo comparten un bloqueo transaccional,
// incluyendo la primera carga: evita perder cambios entre procesos/usuarios.
export async function withShipmentState(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SHIPMENT_KEY]);
    const current = await getState(client);
    const result = await operation(current);
    if (result.state) await kvSet(client, SHIPMENT_KEY, result.state);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export function registerShipmentsRoutes(app, pool, wrap) {
  const withUser = async (req) => {
    const id = resolveUser(req);
    const employees = await kvGet(pool, "employees", []);
    const user = employees.find(e => Number(e.id) === id);
    if (!user) throw httpError(401, "Sesión no válida.");
    const access = accessFor(user);
    if (!access.read) throw httpError(403, "No tiene acceso a Control de embarques.");
    return { user, access };
  };

  app.get("/api/generators/shipments", wrap(async (req, res) => {
    const { access } = await withUser(req);
    const result = await withShipmentState(pool, current => ({ response: publicState(current, access.write) }));
    res.json(result.response);
  }));
  app.post("/api/generators/shipments", wrap(async (req, res) => {
    const { user, access } = await withUser(req);
    if (!access.write) throw httpError(403, "Acceso de solo lectura.");
    const result = await withShipmentState(pool, current => createItem(current, req.body, { userId: user.id, userName: userName(user) }));
    res.status(201).json({ ok: true, item: result.item });
  }));
  app.patch("/api/generators/shipments/:id", wrap(async (req, res) => {
    const { user, access } = await withUser(req);
    if (!access.write) throw httpError(403, "Acceso de solo lectura.");
    const result = await withShipmentState(pool, current => updateItem(current, req.params.id, req.body?.item, req.body?.expectedVersion, { userId: user.id, userName: userName(user) }));
    res.json({ ok: true, item: result.item });
  }));
  app.post("/api/generators/shipments/import/preview", wrap(async (req, res) => {
    const { access } = await withUser(req);
    if (!access.write) throw httpError(403, "Acceso de solo lectura.");
    const encoded = String(req.body?.dataBase64 || "");
    if (!encoded || encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 100) throw httpError(413, "El archivo está vacío o supera 8 MB.");
    const parsed = parseWorkbook(Buffer.from(encoded, "base64"));
    res.json({ ok: true, sheet: parsed.sheetName, rowsFound: parsed.records.length, errors: parsed.errors, preview: parsed.records.slice(0, 12).map(x => ({ ...x, reviewFlags: [] })) });
  }));
  app.post("/api/generators/shipments/import", wrap(async (req, res) => {
    const { user, access } = await withUser(req);
    if (!access.write) throw httpError(403, "Acceso de solo lectura.");
    const encoded = String(req.body?.dataBase64 || "");
    if (!encoded || encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 100) throw httpError(413, "El archivo está vacío o supera 8 MB.");
    const parsed = parseWorkbook(Buffer.from(encoded, "base64"));
    const result = await withShipmentState(pool, current => importWorkbook(current, parsed, { userId: user.id, userName: userName(user), fileName: String(req.body?.fileName || "embarques.xlsx").slice(0, 180) }));
    res.json({ ok: true, ...result.result });
  }));
}
