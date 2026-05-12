// ============================================================
// Copikon Backend ligero — Express + SQLite (better-sqlite3)
// ============================================================
// Modelo: tabla `kv` con (key TEXT PRIMARY KEY, value TEXT JSON).
// Cada colección (employees, projects, projectTasks, erpProducts, etc.)
// se guarda como un array JSON bajo su clave. La API expone CRUD
// genérico compatible con las rutas /api/... que ya usa el frontend.
// ============================================================

import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "copikon.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`);

const getRow = db.prepare("SELECT value FROM kv WHERE key = ?");
const putRow = db.prepare(
  "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
);

function readCol(key) {
  const row = getRow.get(key);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeCol(key, arr) {
  putRow.run(key, JSON.stringify(arr), Date.now());
}

// Mapa de rutas REST → key en la tabla kv
const ROUTES = {
  "/api/employees": "employees",
  "/api/projects": "projects",
  "/api/project-tasks": "projectTasks",
  "/api/copikon-gen-activities": "copikonGenActivities",
  "/api/erp/clients": "erpClients",
  "/api/erp/suppliers": "erpSuppliers",
  "/api/erp/products": "erpProducts",
  "/api/erp/quotes": "erpQuotes",
  "/api/erp/invoices": "erpInvoices",
  "/api/erp/purchase-orders": "erpPurchaseOrders",
  "/api/erp/service-orders": "erpServiceOrders",
  "/api/erp/dispatches": "erpDispatches",
  "/api/erp/visits": "erpVisits",
  "/api/erp/contracts": "erpContracts",
  "/api/erp/leads": "erpLeads",
  "/api/erp/reservations": "erpReservations",
  "/api/salary-bands": "salaryBands",
  "/api/erp/price-bands": "priceBands",
  "/api/erp/rental-contracts": "erpRentalContracts",
  "/api/erp/rental-payments": "erpRentalPayments",
};

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "25mb" }));

// ───── Salud ────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: Date.now(), version: "1.0" });
});

// ───── Login simple (sin hash) ──────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const employees = readCol("employees");
  const emp = employees.find(
    (e) => e && e.username === username && e.password === password
  );
  if (!emp) return res.status(401).json({ message: "Credenciales inválidas" });
  return res.json({ token: `srv-${emp.id}-${Date.now()}`, user: emp });
});

app.get("/api/auth/me", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/, "");
  const m = token.match(/^srv-(\d+)-/);
  if (!m) return res.status(401).json({ message: "Unauthorized" });
  const id = Number(m[1]);
  const emp = readCol("employees").find((e) => Number(e.id) === id);
  if (!emp) return res.status(401).json({ message: "Unauthorized" });
  return res.json(emp);
});

// ───── Departamentos y otros statics (read-only por ahora) ──
const STATIC_KEYS = ["departments", "announcements", "jobDescriptions", "processMaps", "courses"];
STATIC_KEYS.forEach((key) => {
  app.get(`/api/${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`, (_req, res) => {
    res.json(readCol(key));
  });
});

// ───── Migración: subir snapshot de IndexedDB del cliente ──
// Body esperado: { snapshot: { employees: [...], projects: [...], ... }, mode: "replace"|"merge" }
app.post("/api/sync/migrate", (req, res) => {
  const { snapshot, mode = "merge" } = req.body || {};
  if (!snapshot || typeof snapshot !== "object") {
    return res.status(400).json({ message: "snapshot inválido" });
  }
  const results = {};
  for (const [key, arr] of Object.entries(snapshot)) {
    if (!Array.isArray(arr)) continue;
    if (mode === "replace") {
      writeCol(key, arr);
      results[key] = { mode: "replace", count: arr.length };
    } else {
      // merge por id: items entrantes pisan los existentes con mismo id;
      // items existentes que no aparecen se mantienen.
      const existing = readCol(key);
      const byId = new Map(existing.map((it) => [String(it?.id ?? ""), it]));
      for (const it of arr) {
        if (it && it.id != null) byId.set(String(it.id), it);
      }
      // También conservar items entrantes sin id (raros)
      const merged = [
        ...byId.values(),
        ...arr.filter((it) => it && it.id == null),
      ];
      writeCol(key, merged);
      results[key] = { mode: "merge", incoming: arr.length, final: merged.length };
    }
  }
  return res.json({ ok: true, results });
});

// ───── Seed inicial (carga staticData si la BD está vacía) ─
app.post("/api/sync/seed", (req, res) => {
  const { seed } = req.body || {};
  if (!seed || typeof seed !== "object") {
    return res.status(400).json({ message: "seed inválido" });
  }
  const written = {};
  for (const [key, arr] of Object.entries(seed)) {
    if (!Array.isArray(arr)) continue;
    const existing = readCol(key);
    if (existing.length === 0) {
      writeCol(key, arr);
      written[key] = arr.length;
    }
  }
  return res.json({ ok: true, written });
});

// ───── CRUD genérico por colección ──────────────────────────
for (const [route, key] of Object.entries(ROUTES)) {
  // GET list
  app.get(route, (_req, res) => res.json(readCol(key)));

  // GET by id
  app.get(`${route}/:id`, (req, res) => {
    const id = Number(req.params.id);
    const item = readCol(key).find((x) => Number(x.id) === id);
    if (!item) return res.status(404).json({ message: "not found" });
    res.json(item);
  });

  // POST create
  app.post(route, (req, res) => {
    const items = readCol(key);
    const body = req.body || {};
    const nextId = items.reduce((m, it) => Math.max(m, Number(it?.id) || 0), 0) + 1;
    const created = { ...body, id: body.id ?? nextId };
    items.push(created);
    writeCol(key, items);
    res.status(201).json(created);
  });

  // PATCH update by id
  app.patch(`${route}/:id`, (req, res) => {
    const id = Number(req.params.id);
    const items = readCol(key);
    const idx = items.findIndex((x) => Number(x.id) === id);
    if (idx < 0) return res.status(404).json({ message: "not found" });
    items[idx] = { ...items[idx], ...(req.body || {}) };
    writeCol(key, items);
    res.json(items[idx]);
  });

  // PUT replace by id (mismo comportamiento que PATCH para nuestro caso)
  app.put(`${route}/:id`, (req, res) => {
    const id = Number(req.params.id);
    const items = readCol(key);
    const idx = items.findIndex((x) => Number(x.id) === id);
    if (idx < 0) return res.status(404).json({ message: "not found" });
    items[idx] = { ...items[idx], ...(req.body || {}), id };
    writeCol(key, items);
    res.json(items[idx]);
  });

  // DELETE by id
  app.delete(`${route}/:id`, (req, res) => {
    const id = Number(req.params.id);
    const items = readCol(key);
    const idx = items.findIndex((x) => Number(x.id) === id);
    if (idx < 0) return res.status(404).json({ message: "not found" });
    const [removed] = items.splice(idx, 1);
    writeCol(key, items);
    res.json(removed);
  });
}

// ───── Rutas especiales que el frontend ya usa ──────────────

// PUT /api/salary-bands/by-employee — upsert por employeeId
app.put("/api/salary-bands/by-employee", (req, res) => {
  const body = req.body || {};
  const empId = Number(body.employeeId);
  if (!empId) return res.status(400).json({ message: "employeeId requerido" });
  const items = readCol("salaryBands");
  const idx = items.findIndex((b) => Number(b.employeeId) === empId);
  const stamped = { ...body, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...stamped };
    writeCol("salaryBands", items);
    return res.json(items[idx]);
  }
  const nextId = items.reduce((m, it) => Math.max(m, Number(it?.id) || 0), 0) + 1;
  const created = { ...stamped, id: nextId };
  items.push(created);
  writeCol("salaryBands", items);
  return res.status(201).json(created);
});

// PATCH /api/admin/users/:id — actualizar empleado (credenciales/permisos)
app.patch("/api/admin/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const items = readCol("employees");
  const idx = items.findIndex((e) => Number(e.id) === id);
  if (idx < 0) return res.status(404).json({ message: "not found" });
  items[idx] = { ...items[idx], ...(req.body || {}) };
  writeCol("employees", items);
  res.json(items[idx]);
});

// ───── Arranque ─────────────────────────────────────────────
const PORT = process.env.PORT || 5050;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[copikon-server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[copikon-server] DB → ${DB_PATH}`);
});
