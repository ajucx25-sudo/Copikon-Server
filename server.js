// ============================================================
// Copikon Backend ligero — Express + Postgres
// ============================================================
// Modelo: una tabla `kv` con (key TEXT PRIMARY KEY, value JSONB).
// Cada colección (employees, projects, projectTasks, erpProducts, …)
// se guarda como un array JSON bajo su clave. La API expone CRUD
// genérico compatible con las rutas /api/... que ya usa el frontend.
// ============================================================

import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[copikon-server] DATABASE_URL no configurado. Render Postgres lo inyecta automáticamente.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
  max: 5,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
}

async function readCol(key) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  if (!r.rows[0]) return [];
  const v = r.rows[0].value;
  return Array.isArray(v) ? v : [];
}

async function writeCol(key, arr) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(arr ?? []), Date.now()]
  );
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

const STATIC_KEYS = ["departments", "announcements", "jobDescriptions", "processMaps", "courses"];

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "25mb" }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error("[handler]", err);
    res.status(500).json({ message: "internal", error: err?.message });
  });

// ───── Salud ────────────────────────────────────────────────
app.get("/api/health", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, time: Date.now(), version: "1.1", db: "postgres" });
}));

// ───── Login simple (sin hash) ──────────────────────────────
app.post("/api/auth/login", wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const employees = await readCol("employees");
  const emp = employees.find(
    (e) => e && e.username === username && e.password === password
  );
  if (!emp) return res.status(401).json({ message: "Credenciales inválidas" });
  return res.json({ token: `srv-${emp.id}-${Date.now()}`, user: emp });
}));

app.get("/api/auth/me", wrap(async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/, "");
  const m = token.match(/^srv-(\d+)-/);
  if (!m) return res.status(401).json({ message: "Unauthorized" });
  const id = Number(m[1]);
  const employees = await readCol("employees");
  const emp = employees.find((e) => Number(e.id) === id);
  if (!emp) return res.status(401).json({ message: "Unauthorized" });
  return res.json(emp);
}));

// ───── Statics (read-only) ──────────────────────────────────
for (const key of STATIC_KEYS) {
  const route = `/api/${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
  app.get(route, wrap(async (_req, res) => res.json(await readCol(key))));
}

// ───── Migración: subir snapshot de IndexedDB del cliente ──
app.post("/api/sync/migrate", wrap(async (req, res) => {
  const { snapshot, mode = "merge" } = req.body || {};
  if (!snapshot || typeof snapshot !== "object") {
    return res.status(400).json({ message: "snapshot inválido" });
  }
  const results = {};
  for (const [key, arr] of Object.entries(snapshot)) {
    if (!Array.isArray(arr)) continue;
    if (mode === "replace") {
      await writeCol(key, arr);
      results[key] = { mode: "replace", count: arr.length };
    } else {
      const existing = await readCol(key);
      const byId = new Map(existing.map((it) => [String(it?.id ?? ""), it]));
      for (const it of arr) {
        if (it && it.id != null) byId.set(String(it.id), it);
      }
      const merged = [
        ...byId.values(),
        ...arr.filter((it) => it && it.id == null),
      ];
      await writeCol(key, merged);
      results[key] = { mode: "merge", incoming: arr.length, final: merged.length };
    }
  }
  return res.json({ ok: true, results });
}));

// ───── Seed inicial ─────────────────────────────────────────
app.post("/api/sync/seed", wrap(async (req, res) => {
  const { seed } = req.body || {};
  if (!seed || typeof seed !== "object") {
    return res.status(400).json({ message: "seed inválido" });
  }
  const written = {};
  for (const [key, arr] of Object.entries(seed)) {
    if (!Array.isArray(arr)) continue;
    const existing = await readCol(key);
    if (existing.length === 0) {
      await writeCol(key, arr);
      written[key] = arr.length;
    }
  }
  return res.json({ ok: true, written });
}));

// ───── CRUD genérico por colección ──────────────────────────
for (const [route, key] of Object.entries(ROUTES)) {
  app.get(route, wrap(async (_req, res) => res.json(await readCol(key))));

  app.get(`${route}/:id`, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const items = await readCol(key);
    const item = items.find((x) => Number(x.id) === id);
    if (!item) return res.status(404).json({ message: "not found" });
    res.json(item);
  }));

  app.post(route, wrap(async (req, res) => {
    const items = await readCol(key);
    const body = req.body || {};
    const nextId = items.reduce((m, it) => Math.max(m, Number(it?.id) || 0), 0) + 1;
    const created = { ...body, id: body.id ?? nextId };
    items.push(created);
    await writeCol(key, items);
    res.status(201).json(created);
  }));

  app.patch(`${route}/:id`, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const items = await readCol(key);
    const idx = items.findIndex((x) => Number(x.id) === id);
    if (idx < 0) return res.status(404).json({ message: "not found" });
    items[idx] = { ...items[idx], ...(req.body || {}) };
    await writeCol(key, items);
    res.json(items[idx]);
  }));

  app.put(`${route}/:id`, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const items = await readCol(key);
    const idx = items.findIndex((x) => Number(x.id) === id);
    if (idx < 0) return res.status(404).json({ message: "not found" });
    items[idx] = { ...items[idx], ...(req.body || {}), id };
    await writeCol(key, items);
    res.json(items[idx]);
  }));

  app.delete(`${route}/:id`, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const items = await readCol(key);
    const idx = items.findIndex((x) => Number(x.id) === id);
    if (idx < 0) return res.status(404).json({ message: "not found" });
    const [removed] = items.splice(idx, 1);
    await writeCol(key, items);
    res.json(removed);
  }));
}

// ───── Rutas especiales ─────────────────────────────────────

// PUT /api/salary-bands/by-employee — upsert por employeeId
app.put("/api/salary-bands/by-employee", wrap(async (req, res) => {
  const body = req.body || {};
  const empId = Number(body.employeeId);
  if (!empId) return res.status(400).json({ message: "employeeId requerido" });
  const items = await readCol("salaryBands");
  const idx = items.findIndex((b) => Number(b.employeeId) === empId);
  const stamped = { ...body, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...stamped };
    await writeCol("salaryBands", items);
    return res.json(items[idx]);
  }
  const nextId = items.reduce((m, it) => Math.max(m, Number(it?.id) || 0), 0) + 1;
  const created = { ...stamped, id: nextId };
  items.push(created);
  await writeCol("salaryBands", items);
  return res.status(201).json(created);
}));

// GET /api/admin/users — lista de empleados con permisos formateada
app.get("/api/admin/users", wrap(async (_req, res) => {
  const employees = await readCol("employees");
  const departments = await readCol("departments");
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
  };
  const out = employees.map((emp) => {
    const dept = departments.find((d) => Number(d.id) === Number(emp.departmentId));
    return {
      id: emp.id,
      firstName: emp.firstName,
      lastName: emp.lastName,
      position: emp.position,
      department: dept?.shortName ?? dept?.name ?? "—",
      departmentId: emp.departmentId,
      cedula: emp.cedula,
      email: emp.email,
      phone: emp.phone,
      level: emp.level,
      username: emp.username || "",
      hasPassword: !!emp.password,
      mustChangePassword: !!emp.mustChangePassword,
      canAccessGeneralMenu: !!emp.canAccessGeneralMenu,
      moduleAccess: parseArr(emp.moduleAccess),
      menuAccess: parseArr(emp.menuAccess),
      status: emp.status,
    };
  });
  res.json(out);
}));

// GET /api/erp/products/:id/serials — stub: devuelve arreglo (vacío por ahora)
app.get("/api/erp/products/:id/serials", wrap(async (req, res) => {
  const all = await readCol("productSerials").catch(() => []);
  const list = Array.isArray(all) ? all.filter(s => Number(s.productId) === Number(req.params.id)) : [];
  res.json(list);
}));

// POST /api/erp/products/:id/serials — agregar serial
app.post("/api/erp/products/:id/serials", wrap(async (req, res) => {
  const productId = Number(req.params.id);
  const items = await readCol("productSerials").catch(() => []);
  const arr = Array.isArray(items) ? items : [];
  const nextId = arr.reduce((m, it) => Math.max(m, Number(it?.id) || 0), 0) + 1;
  const created = { ...(req.body || {}), id: nextId, productId, createdAt: new Date().toISOString() };
  arr.push(created);
  await writeCol("productSerials", arr);
  res.status(201).json(created);
}));

// PATCH /api/erp/product-serials/:id
app.patch("/api/erp/product-serials/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = (await readCol("productSerials").catch(() => [])) || [];
  if (!Array.isArray(arr)) return res.status(404).json({ message: "not found" });
  const idx = arr.findIndex(s => Number(s.id) === id);
  if (idx < 0) return res.status(404).json({ message: "not found" });
  arr[idx] = { ...arr[idx], ...(req.body || {}) };
  await writeCol("productSerials", arr);
  res.json(arr[idx]);
}));

// DELETE /api/erp/product-serials/:id
app.delete("/api/erp/product-serials/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = (await readCol("productSerials").catch(() => [])) || [];
  if (!Array.isArray(arr)) return res.status(404).json({ message: "not found" });
  const idx = arr.findIndex(s => Number(s.id) === id);
  if (idx < 0) return res.status(404).json({ message: "not found" });
  const [removed] = arr.splice(idx, 1);
  await writeCol("productSerials", arr);
  res.json(removed);
}));

// ───── Adjuntos de tareas de proyectos ──────────────────────
// Los attachments viven inline en cada projectTask bajo la propiedad
// `attachments` (array). dataUrl base64 embebido (max 25MB por request).

function parseAttachments(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// POST /api/project-tasks/:id/attachments — agregar adjunto
app.post("/api/project-tasks/:id/attachments", wrap(async (req, res) => {
  const taskId = Number(req.params.id);
  const items = await readCol("projectTasks");
  const idx = items.findIndex((t) => Number(t.id) === taskId);
  if (idx < 0) return res.status(404).json({ message: "task not found" });
  const body = req.body || {};
  const mime = body.mimeType || "application/octet-stream";
  const dataUrl = body.dataBase64 ? `data:${mime};base64,${body.dataBase64}` : (body.dataUrl || "");
  const size = body.size ?? (body.dataBase64 ? Math.floor((body.dataBase64.length * 3) / 4) : 0);
  const newAttachment = {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    filename: body.filename || "archivo",
    mimeType: mime,
    size,
    dataUrl,
    uploadedAt: new Date().toISOString(),
    uploadedBy: body.uploadedBy ?? null,
    uploadedByName: body.uploadedByName ?? null,
  };
  const current = parseAttachments(items[idx].attachments);
  items[idx] = { ...items[idx], attachments: [...current, newAttachment] };
  await writeCol("projectTasks", items);
  res.status(201).json(newAttachment);
}));

// GET /api/project-tasks/:id/attachments/:attId — descargar (devuelve dataUrl)
app.get("/api/project-tasks/:id/attachments/:attId", wrap(async (req, res) => {
  const taskId = Number(req.params.id);
  const attId = req.params.attId;
  const items = await readCol("projectTasks");
  const task = items.find((t) => Number(t.id) === taskId);
  if (!task) return res.status(404).json({ message: "task not found" });
  const atts = parseAttachments(task.attachments);
  const att = atts.find((a) => a.id === attId);
  if (!att) return res.status(404).json({ message: "attachment not found" });
  // Si tiene dataUrl, devolver el binario directamente
  if (att.dataUrl && typeof att.dataUrl === "string") {
    const m = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      const buf = Buffer.from(m[2], "base64");
      const download = req.query.download === "1";
      res.setHeader("Content-Type", m[1]);
      if (download) res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(att.filename || "archivo")}"`);
      return res.end(buf);
    }
  }
  res.json(att);
}));

// DELETE /api/project-tasks/:id/attachments/:attId — eliminar adjunto
app.delete("/api/project-tasks/:id/attachments/:attId", wrap(async (req, res) => {
  const taskId = Number(req.params.id);
  const attId = req.params.attId;
  const items = await readCol("projectTasks");
  const idx = items.findIndex((t) => Number(t.id) === taskId);
  if (idx < 0) return res.status(404).json({ message: "task not found" });
  const current = parseAttachments(items[idx].attachments);
  const next = current.filter((a) => a.id !== attId);
  items[idx] = { ...items[idx], attachments: next };
  await writeCol("projectTasks", items);
  res.json({ ok: true });
}));

// PATCH /api/admin/users/:id — credenciales/permisos
app.patch("/api/admin/users/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const items = await readCol("employees");
  const idx = items.findIndex((e) => Number(e.id) === id);
  if (idx < 0) return res.status(404).json({ message: "not found" });
  const body = { ...(req.body || {}) };
  // Normalizar: el frontend manda arrays pero algunas filas viejas usan JSON-string
  if (Array.isArray(body.moduleAccess)) body.moduleAccess = body.moduleAccess;
  if (Array.isArray(body.menuAccess)) body.menuAccess = body.menuAccess;
  items[idx] = { ...items[idx], ...body };
  await writeCol("employees", items);
  res.json(items[idx]);
}));

// POST /api/admin/users/:id/reset-password — reset al cédula o copikon2026
app.post("/api/admin/users/:id/reset-password", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const items = await readCol("employees");
  const idx = items.findIndex((e) => Number(e.id) === id);
  if (idx < 0) return res.status(404).json({ message: "not found" });
  const cedula = items[idx].cedula && String(items[idx].cedula).trim();
  const newPass = cedula || "copikon2026";
  items[idx] = { ...items[idx], password: newPass, mustChangePassword: 1 };
  await writeCol("employees", items);
  res.json({ ok: true, newPassword: newPass });
}));

// ───── Arranque ─────────────────────────────────────────────
const PORT = process.env.PORT || 5050;
(async () => {
  try {
    await ensureSchema();
    console.log("[copikon-server] schema ready");
  } catch (e) {
    console.error("[copikon-server] schema init failed:", e);
    process.exit(1);
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[copikon-server] listening on http://0.0.0.0:${PORT}`);
  });
})();
