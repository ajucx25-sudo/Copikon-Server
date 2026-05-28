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
  "/api/erp/rental-maintenance": "erpRentalMaintenance",
  "/api/erp/rental-invoices": "erpRentalInvoices",
  "/api/erp/maintenance-orders": "erpMaintenanceOrders",
  "/api/erp/maintenance-plans": "erpMaintenancePlans",
  "/api/erp/maintenance-contracts": "erpMaintenanceContracts",
  "/api/erp/client-equipment": "erpClientEquipment",
  "/api/erp/supplier-bills": "erpSupplierBills",
  "/api/erp/operating-expenses": "erpOperatingExpenses",
  "/api/erp/suppliers": "erpSuppliers",
  "/api/maintenance-packages": "maintenancePackages",
  "/api/extra-services": "extraServices",
  "/api/technical-providers": "technicalProviders",
  "/api/erp/sales-invoices": "erpSalesInvoices",
  "/api/sales-partners": "salesPartners",
  // CPK Logística v37 (nuevo módulo)
  "/api/logistica/shipments": "logisticaShipments",
  "/api/logistica/imports": "logisticaImports",
  "/api/logistica/carriers": "logisticaCarriers",
  // WMS v53 (módulo principal transversal)
  "/api/wms/locations": "wmsLocations",
  "/api/wms/receipts": "wmsReceipts",
  "/api/wms/picks": "wmsPicks",
  "/api/wms/cycle-counts": "wmsCycleCounts",
  "/api/wms/packings": "wmsPackings",
  "/api/wms/dispatches": "wmsDispatches",
};

const STATIC_KEYS = ["departments", "announcements", "jobDescriptions", "processMaps", "courses"];

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "60mb" }));

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
// Construye user shape para partner externo
function buildPartnerUser(p) {
  return {
    id: `p-${p.id}`,
    salesPartnerId: p.id,
    username: p.username || "",
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    email: p.email || "",
    phone: p.phone || "",
    cedula: p.cedula || "",
    position: "Partner Externo",
    company: p.company || "",
    region: p.region || "",
    level: "partner_externo",
    role: "partner_externo",
    isPartner: true,
    tier: p.tier || "bronze",
    commissionPct: Number(p.commissionPct) || 0,
    monthlyGoalUsd: Number(p.monthlyGoalUsd) || 0,
    annualGoalUsd: Number(p.annualGoalUsd) || 0,
    canAccessGeneralMenu: false,
    moduleAccess: ["generators-ventas", "modo-campo", "mi-portal"],
    menuAccess: ["dashboard", "leads", "rutas", "catalogo", "mi_perfil"],
    status: p.status || "active",
  };
}

app.post("/api/auth/login", wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const employees = await readCol("employees");
  const emp = employees.find(
    (e) => e && e.username === username && e.password === password
  );
  if (emp) {
    return res.json({ token: `srv-${emp.id}-${Date.now()}`, user: emp });
  }
  // Buscar en partners externos
  const partners = await readCol("salesPartners").catch(() => []);
  const p = (Array.isArray(partners) ? partners : []).find(
    (x) => x && x.username && String(x.username) === String(username) && String(x.password ?? "") === String(password ?? "")
  );
  if (p) {
    if (p.canLogin === false || p.canLogin === 0 || p.canLogin === "false") {
      return res.status(403).json({ message: "Acceso desactivado. Contacta al administrador." });
    }
    if (p.status === "inactive") {
      return res.status(403).json({ message: "Partner inactivo." });
    }
    return res.json({ token: `srv-p${p.id}-${Date.now()}`, user: buildPartnerUser(p) });
  }
  return res.status(401).json({ message: "Credenciales inválidas" });
}));

app.get("/api/auth/me", wrap(async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/, "");
  // Token partner: srv-p<id>-<ts>
  const mp = token.match(/^srv-p(\d+)-/);
  if (mp) {
    const pid = Number(mp[1]);
    const partners = await readCol("salesPartners").catch(() => []);
    const p = (Array.isArray(partners) ? partners : []).find((x) => Number(x.id) === pid);
    if (!p) return res.status(401).json({ message: "Unauthorized" });
    if (p.canLogin === false || p.status === "inactive") {
      return res.status(401).json({ message: "Acceso revocado" });
    }
    return res.json(buildPartnerUser(p));
  }
  const m = token.match(/^srv-(\d+)-/);
  if (!m) return res.status(401).json({ message: "Unauthorized" });
  const id = Number(m[1]);
  const employees = await readCol("employees");
  const emp = employees.find((e) => Number(e.id) === id);
  if (!emp) return res.status(401).json({ message: "Unauthorized" });
  return res.json(emp);
}));

// ───── Cambio de contraseña (usuario autenticado) ───────────
app.post("/api/auth/change-password", wrap(async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/, "");
  const m = token.match(/^srv-(\d+)-/);
  if (!m) return res.status(401).json({ message: "Unauthorized" });
  const id = Number(m[1]);
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
  }
  const employees = await readCol("employees");
  const idx = employees.findIndex((e) => Number(e.id) === id);
  if (idx < 0) return res.status(401).json({ error: "Usuario no encontrado" });
  const emp = employees[idx];
  if (String(emp.password ?? "") !== String(currentPassword ?? "")) {
    return res.status(400).json({ error: "La contraseña actual es incorrecta" });
  }
  if (String(newPassword) === String(currentPassword)) {
    return res.status(400).json({ error: "La nueva contraseña debe ser distinta a la actual" });
  }
  employees[idx] = { ...emp, password: String(newPassword), mustChangePassword: 0 };
  await writeCol("employees", employees);
  return res.json({ ok: true, user: employees[idx] });
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

// ───── Rutas ESPECIALES (deben ir ANTES del CRUD genérico) ─
// Si se registran después del loop, /api/salary-bands/by-employee
// es atrapado por el handler PUT /api/salary-bands/:id genérico
// (Express casa la primera ruta registrada) → :id = "by-employee"
// → Number(NaN) → 404. Por eso este bloque va aquí.

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

// ───── Sanitizado GET sales-partners (oculta password) ─────────
function sanitizePartner(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  if (out.password != null) {
    out.hasPassword = true;
    delete out.password;
  } else {
    out.hasPassword = false;
  }
  return out;
}
app.get("/api/sales-partners", wrap(async (_req, res) => {
  const arr = await readCol("salesPartners").catch(() => []);
  res.json((Array.isArray(arr) ? arr : []).map(sanitizePartner));
}));
app.get("/api/sales-partners/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = await readCol("salesPartners").catch(() => []);
  const it = (Array.isArray(arr) ? arr : []).find((x) => Number(x.id) === id);
  if (!it) return res.status(404).json({ message: "not found" });
  res.json(sanitizePartner(it));
}));

// ───── CRUD genérico por colección ──────────────────────────
for (const [route, key] of Object.entries(ROUTES)) {
  // Skip GET para sales-partners (ya manejado arriba con sanitización)
  if (route !== "/api/sales-partners") {
    app.get(route, wrap(async (_req, res) => res.json(await readCol(key))));
  }

  if (route !== "/api/sales-partners") {
    app.get(`${route}/:id`, wrap(async (req, res) => {
      const id = Number(req.params.id);
      const items = await readCol(key);
      const item = items.find((x) => Number(x.id) === id);
      if (!item) return res.status(404).json({ message: "not found" });
      res.json(item);
    }));
  }

  app.post(route, wrap(async (req, res) => {
    const items = await readCol(key);
    const body = req.body || {};
    // Anti-duplicado: si el body trae un id que ya existe, devolver el existente
    // (idempotencia para retries/clicks múltiples). Aplica a TODAS las rutas /api/...
    if (body.id != null) {
      const existing = items.find((it) => Number(it?.id) === Number(body.id));
      if (existing) {
        return res.status(200).json(existing);
      }
    }
    // Anti-duplicado específico para clientes ERP: si viene convertedFromLeadId,
    // y ya existe un cliente con ese leadId, devolver el existente (no crear copia).
    if (key === "erpClients" && body.convertedFromLeadId != null) {
      const existing = items.find((it) => Number(it?.convertedFromLeadId) === Number(body.convertedFromLeadId));
      if (existing) {
        return res.status(200).json(existing);
      }
    }
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

// ───── Otras rutas especiales ───────────────────────────────

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

// ───── Credenciales de partners externos ───────────────────
// POST /api/sales-partners/:id/set-credentials — { username, password, canLogin }
app.post("/api/sales-partners/:id/set-credentials", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = await readCol("salesPartners").catch(() => []);
  if (!Array.isArray(arr)) return res.status(404).json({ message: "not found" });
  const idx = arr.findIndex((p) => Number(p.id) === id);
  if (idx < 0) return res.status(404).json({ message: "partner not found" });
  const body = req.body || {};
  const updates = {};
  if (typeof body.username === "string") {
    const u = body.username.trim().toLowerCase();
    if (u) {
      // Validar unicidad contra employees y otros partners
      const employees = await readCol("employees").catch(() => []);
      const empClash = (employees || []).some((e) => e && String(e.username || "").toLowerCase() === u);
      const partnerClash = arr.some((p, i) => i !== idx && String(p.username || "").toLowerCase() === u);
      if (empClash || partnerClash) {
        return res.status(409).json({ message: "El nombre de usuario ya está en uso" });
      }
      updates.username = u;
    } else {
      updates.username = "";
    }
  }
  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 6) {
      return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres" });
    }
    updates.password = body.password;
    updates.mustChangePassword = body.mustChangePassword ? 1 : 0;
  }
  if (typeof body.canLogin === "boolean") {
    updates.canLogin = body.canLogin;
  }
  arr[idx] = { ...arr[idx], ...updates };
  await writeCol("salesPartners", arr);
  const safe = { ...arr[idx] };
  delete safe.password;
  res.json({ ok: true, partner: safe });
}));

// ───── Acceso a Partners Externos (panel Usuarios y Permisos) ─────
// Endpoints "one-click" para gestionar credenciales desde el panel admin,
// análogos a los de technical-providers. Genera username/password si no
// se proveen y devuelve las credenciales en la respuesta.

function generatePartnerUsername(p) {
  const email = String(p.email || "").trim().toLowerCase();
  if (email.includes("@")) {
    const local = email.split("@")[0];
    const clean = local.replace(/[^a-z0-9.]/g, "").slice(0, 24);
    if (clean) return clean;
  }
  const first = String(p.firstName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const last = String(p.lastName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (first && last) return `${first}.${last}`.slice(0, 30);
  if (first) return first;
  return `partner${p.id}`;
}

function generatePartnerPassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// GET /api/admin/sales-partners — lista para panel Usuarios y Permisos
app.get("/api/admin/sales-partners", wrap(async (_req, res) => {
  const arr = await readCol("salesPartners").catch(() => []);
  const out = (arr || []).map((p) => {
    const safe = { ...p };
    delete safe.password;
    safe.hasLogin = !!(p.username && p.password && p.canLogin !== false);
    safe.hasPassword = !!p.password;
    return safe;
  });
  res.json(out);
}));

// POST /api/admin/sales-partners/:id/grant-access — crea o reactiva acceso
app.post("/api/admin/sales-partners/:id/grant-access", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = await readCol("salesPartners").catch(() => []);
  const idx = (arr || []).findIndex((p) => Number(p.id) === id);
  if (idx < 0) return res.status(404).json({ message: "partner not found" });
  const p = arr[idx];
  const body = req.body || {};

  let username = String(body.username || p.username || "").trim().toLowerCase();
  if (!username) username = generatePartnerUsername(p);
  // Validar unicidad
  const employees = await readCol("employees").catch(() => []);
  const empClash = (employees || []).some((e) => e && String(e.username || "").toLowerCase() === username);
  const partnerClash = arr.some((other, i) => i !== idx && String(other.username || "").toLowerCase() === username);
  if (empClash || partnerClash) {
    // probar variantes con sufijo numérico
    let resolved = false;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${username}${i}`;
      const c1 = (employees || []).some((e) => e && String(e.username || "").toLowerCase() === candidate);
      const c2 = arr.some((other, j) => j !== idx && String(other.username || "").toLowerCase() === candidate);
      if (!c1 && !c2) { username = candidate; resolved = true; break; }
    }
    if (!resolved) return res.status(409).json({ message: "No se pudo generar un username único" });
  }

  const password = String(body.password || "").trim() || generatePartnerPassword();
  if (password.length < 6) return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres" });

  arr[idx] = {
    ...p,
    username,
    password,
    canLogin: true,
    mustChangePassword: 1,
  };
  await writeCol("salesPartners", arr);
  res.json({
    ok: true,
    action: p.username && p.password ? "updated" : "created",
    partnerId: id,
    username,
    password,
  });
}));

// POST /api/admin/sales-partners/:id/reset-access — resetea contraseña
app.post("/api/admin/sales-partners/:id/reset-access", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = await readCol("salesPartners").catch(() => []);
  const idx = (arr || []).findIndex((p) => Number(p.id) === id);
  if (idx < 0) return res.status(404).json({ message: "partner not found" });
  const p = arr[idx];
  if (!p.username) return res.status(400).json({ message: "El partner no tiene acceso aún. Usá grant-access primero." });
  const newPassword = String(req.body?.password || "").trim() || generatePartnerPassword();
  if (newPassword.length < 6) return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres" });
  arr[idx] = { ...p, password: newPassword, canLogin: true, mustChangePassword: 1 };
  await writeCol("salesPartners", arr);
  res.json({ ok: true, partnerId: id, username: p.username, newPassword });
}));

// DELETE /api/admin/sales-partners/:id/revoke-access — revoca acceso (mantiene partner)
app.delete("/api/admin/sales-partners/:id/revoke-access", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const arr = await readCol("salesPartners").catch(() => []);
  const idx = (arr || []).findIndex((p) => Number(p.id) === id);
  if (idx < 0) return res.status(404).json({ message: "partner not found" });
  arr[idx] = { ...arr[idx], canLogin: false };
  await writeCol("salesPartners", arr);
  res.json({ ok: true, partnerId: id });
}));

// ───── Acceso a técnicos externos (proveedores) ────────────
// Cada proveedor externo puede tener un "employee sintético" asociado vía
// providerId. Este empleado existe solo para autenticar y aparecer como
// usuario del PWA en modo campo. NO se debe mostrar en organigrama ni
// listados de personal interno.

function normalizeUsernameFromEmail(emailOrName) {
  const s = String(emailOrName || "").trim();
  if (!s) return "";
  // Si parece email, usar parte local o el email completo
  if (s.includes("@")) return s.toLowerCase().replace(/\s+/g, "");
  return s.toLowerCase().replace(/[^a-z0-9.]/g, ".").replace(/\.+/g, ".");
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || "Técnico", lastName: "Externo" };
  const firstName = parts.slice(0, Math.ceil(parts.length / 2)).join(" ");
  const lastName = parts.slice(Math.ceil(parts.length / 2)).join(" ");
  return { firstName, lastName };
}

// GET /api/admin/technical-providers — lista con campo derivado hasLogin
app.get("/api/admin/technical-providers", wrap(async (_req, res) => {
  const providers = await readCol("technicalProviders");
  const employees = await readCol("employees");
  const out = (providers || []).map((p) => {
    const emp = employees.find((e) => Number(e.providerId) === Number(p.id));
    return {
      ...p,
      hasLogin: !!emp,
      loginUsername: emp ? emp.username : null,
      loginUserId: emp ? emp.id : null,
      mustChangePassword: emp ? !!emp.mustChangePassword : false,
    };
  });
  res.json(out);
}));

// POST /api/admin/technical-providers/:id/grant-access
// Crea o actualiza el empleado sintético para el proveedor. Devuelve
// credenciales (sólo en la respuesta, no se vuelven a exponer).
// Body opcional: { username?, password? } — si vacío, se generan.
app.post("/api/admin/technical-providers/:id/grant-access", wrap(async (req, res) => {
  const providerId = Number(req.params.id);
  const providers = await readCol("technicalProviders");
  const provider = providers.find((p) => Number(p.id) === providerId);
  if (!provider) return res.status(404).json({ message: "proveedor no encontrado" });

  const employees = await readCol("employees");
  const existingIdx = employees.findIndex((e) => Number(e.providerId) === providerId);

  const body = req.body || {};
  const desiredUsername = String(body.username || "").trim() ||
    normalizeUsernameFromEmail(provider.email || provider.name) ||
    `tecnico${providerId}`;

  // Generar contraseña si no se provee (cedula del proveedor o aleatoria)
  const cedula = String(provider.taxId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const defaultPassword = cedula || `tec${providerId}${Math.random().toString(36).slice(2, 6)}`;
  const desiredPassword = String(body.password || "").trim() || defaultPassword;

  // Validar que el username no esté tomado por OTRO empleado
  const clash = employees.find((e) =>
    String(e.username || "").toLowerCase() === desiredUsername.toLowerCase() &&
    Number(e.providerId || 0) !== providerId
  );
  if (clash) {
    return res.status(409).json({ message: "username ya está en uso por otro usuario" });
  }

  const { firstName, lastName } = splitName(provider.contactName || provider.name);

  if (existingIdx >= 0) {
    // Actualizar credenciales
    employees[existingIdx] = {
      ...employees[existingIdx],
      username: desiredUsername,
      password: desiredPassword,
      mustChangePassword: 1,
      providerId,
      role: "tecnico_externo",
      level: "tecnico_externo",
      firstName,
      lastName,
      email: provider.email || employees[existingIdx].email || "",
      phone: provider.phone || employees[existingIdx].phone || "",
      status: "active",
      isExternalProvider: true,
      position: "Técnico Externo",
    };
    await writeCol("employees", employees);
    return res.json({
      ok: true,
      action: "updated",
      userId: employees[existingIdx].id,
      username: desiredUsername,
      password: desiredPassword,
      providerId,
    });
  }

  // Crear nuevo empleado sintético
  const nextId = employees.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1;
  const synthetic = {
    id: nextId,
    firstName,
    lastName,
    position: "Técnico Externo",
    email: provider.email || "",
    phone: provider.phone || "",
    cedula: provider.taxId || "",
    username: desiredUsername,
    password: desiredPassword,
    mustChangePassword: 1,
    status: "active",
    level: "tecnico_externo",
    role: "tecnico_externo",
    providerId,
    isExternalProvider: true,
    canAccessGeneralMenu: false,
    moduleAccess: [],
    menuAccess: ["modo-campo"],
    departmentId: null,
    createdAt: new Date().toISOString(),
  };
  employees.push(synthetic);
  await writeCol("employees", employees);
  res.status(201).json({
    ok: true,
    action: "created",
    userId: nextId,
    username: desiredUsername,
    password: desiredPassword,
    providerId,
  });
}));

// POST /api/admin/technical-providers/:id/reset-access — resetea password
app.post("/api/admin/technical-providers/:id/reset-access", wrap(async (req, res) => {
  const providerId = Number(req.params.id);
  const providers = await readCol("technicalProviders");
  const provider = providers.find((p) => Number(p.id) === providerId);
  if (!provider) return res.status(404).json({ message: "proveedor no encontrado" });
  const employees = await readCol("employees");
  const idx = employees.findIndex((e) => Number(e.providerId) === providerId);
  if (idx < 0) return res.status(404).json({ message: "no hay acceso creado para este proveedor" });
  const cedula = String(provider.taxId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const newPass = String(req.body?.password || "").trim() || cedula || `tec${providerId}${Math.random().toString(36).slice(2, 6)}`;
  employees[idx] = { ...employees[idx], password: newPass, mustChangePassword: 1 };
  await writeCol("employees", employees);
  res.json({ ok: true, newPassword: newPass, username: employees[idx].username });
}));

// DELETE /api/admin/technical-providers/:id/revoke-access — revoca acceso
app.delete("/api/admin/technical-providers/:id/revoke-access", wrap(async (req, res) => {
  const providerId = Number(req.params.id);
  const employees = await readCol("employees");
  const idx = employees.findIndex((e) => Number(e.providerId) === providerId);
  if (idx < 0) return res.status(404).json({ message: "no hay acceso" });
  const [removed] = employees.splice(idx, 1);
  await writeCol("employees", employees);
  res.json({ ok: true, removedUserId: removed.id });
}));

// ───── Marketing · Materiales Corporativos (v2 — storage por archivo) ─────
// Esquema:
//   `material:<key>:meta`         → { url, fileIds: [...], updatedAt }
//   `material:<key>:file:<id>`    → { filename, mimeType, dataBase64, size, uploadedAt }
//
// Migración automática desde el esquema viejo `material:<key>` (un solo blob con
// todos los archivos) la primera vez que se accede a cada key.

const MATERIAL_DEFS = [
  { key: "presentacion_corporativa", title: "Presentación Corporativa", kind: "pdf" },
  { key: "catalogo_productos",       title: "Catálogo de Productos",   kind: "pdf" },
  { key: "brochure",                 title: "Brochure Institucional",   kind: "pdf" },
  { key: "casos_exito",              title: "Casos de Éxito / Referencias", kind: "pdf" },
  { key: "certificaciones",          title: "Certificaciones y Garantías",  kind: "pdf" },
  { key: "video_corporativo",        title: "Video Corporativo",        kind: "video" },
];

function newFileId() {
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readMaterialMeta(key) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [`material:${key}:meta`]);
  if (!r.rows[0]) return null;
  const v = r.rows[0].value;
  if (!v || typeof v !== "object") return null;
  return {
    url: typeof v.url === "string" ? v.url : "",
    fileIds: Array.isArray(v.fileIds) ? v.fileIds.map(String) : [],
    updatedAt: v.updatedAt || null,
  };
}

async function writeMaterialMeta(key, meta) {
  const payload = {
    url: meta.url || "",
    fileIds: Array.isArray(meta.fileIds) ? meta.fileIds : [],
    updatedAt: meta.updatedAt || new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [`material:${key}:meta`, JSON.stringify(payload), Date.now()]
  );
}

async function deleteMaterialMeta(key) {
  await pool.query("DELETE FROM kv WHERE key = $1", [`material:${key}:meta`]);
}

async function readMaterialFile(key, fileId) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [`material:${key}:file:${fileId}`]);
  if (!r.rows[0]) return null;
  const v = r.rows[0].value;
  if (!v || typeof v !== "object") return null;
  return {
    id: fileId,
    filename: v.filename || "documento",
    mimeType: v.mimeType || "application/octet-stream",
    dataBase64: typeof v.dataBase64 === "string" ? v.dataBase64 : "",
    size: Number(v.size) || 0,
    uploadedAt: v.uploadedAt || null,
  };
}

async function readMaterialFileMeta(key, fileId) {
  // Sólo metadata, sin el blob (para no cargar MBs por nada)
  const r = await pool.query(
    "SELECT value - 'dataBase64' AS m FROM kv WHERE key = $1",
    [`material:${key}:file:${fileId}`]
  );
  if (!r.rows[0]) return null;
  const m = r.rows[0].m;
  if (!m || typeof m !== "object") return null;
  return {
    id: fileId,
    filename: m.filename || "documento",
    mimeType: m.mimeType || "application/octet-stream",
    size: Number(m.size) || 0,
    uploadedAt: m.uploadedAt || null,
  };
}

async function writeMaterialFile(key, fileId, fileData) {
  const payload = {
    filename: String(fileData.filename || "documento"),
    mimeType: String(fileData.mimeType || "application/octet-stream"),
    dataBase64: String(fileData.dataBase64 || ""),
    size: Number(fileData.size) || 0,
    uploadedAt: fileData.uploadedAt || new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [`material:${key}:file:${fileId}`, JSON.stringify(payload), Date.now()]
  );
}

async function deleteMaterialFile(key, fileId) {
  await pool.query("DELETE FROM kv WHERE key = $1", [`material:${key}:file:${fileId}`]);
}

async function deleteAllMaterialFiles(key) {
  await pool.query("DELETE FROM kv WHERE key LIKE $1", [`material:${key}:file:%`]);
}

// Migración automática desde esquema viejo `material:<key>` (un solo blob).
async function migrateIfNeeded(key) {
  const meta = await readMaterialMeta(key);
  if (meta) return; // ya migrado
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [`material:${key}`]);
  if (!r.rows[0]) return;
  const old = r.rows[0].value;
  if (!old || typeof old !== "object") return;

  const filesOld = [];
  if (Array.isArray(old.files) && old.files.length > 0) {
    for (const f of old.files) {
      if (!f) continue;
      filesOld.push({
        id: f.id || newFileId(),
        filename: f.filename || "documento",
        mimeType: f.mimeType || "application/octet-stream",
        dataBase64: f.dataBase64 || "",
        size: Number(f.size) || 0,
        uploadedAt: f.uploadedAt || old.updatedAt || new Date().toISOString(),
      });
    }
  } else if (old.dataBase64) {
    filesOld.push({
      id: newFileId(),
      filename: old.filename || "documento.pdf",
      mimeType: old.mimeType || "application/pdf",
      dataBase64: old.dataBase64,
      size: Number(old.size) || 0,
      uploadedAt: old.updatedAt || new Date().toISOString(),
    });
  }

  const fileIds = [];
  for (const f of filesOld) {
    try {
      await writeMaterialFile(key, f.id, f);
      fileIds.push(f.id);
    } catch (e) {
      console.warn(`[materials] migracion: error con archivo de ${key}:`, e?.message || e);
    }
  }
  await writeMaterialMeta(key, {
    url: typeof old.url === "string" ? old.url : "",
    fileIds,
    updatedAt: old.updatedAt || new Date().toISOString(),
  });
  if (fileIds.length === filesOld.length) {
    try {
      await pool.query("DELETE FROM kv WHERE key = $1", [`material:${key}`]);
      console.log(`[materials] migrado ${key}: ${fileIds.length} archivos a esquema v2`);
    } catch (e) {
      console.warn(`[materials] no se pudo borrar blob viejo de ${key}:`, e?.message || e);
    }
  }
}

async function readMaterial(key) {
  await migrateIfNeeded(key);
  const meta = await readMaterialMeta(key);
  if (!meta) return { files: [], url: "", updatedAt: null };
  const files = [];
  for (const id of meta.fileIds) {
    const fm = await readMaterialFileMeta(key, id);
    if (fm) files.push(fm);
  }
  return { files, url: meta.url || "", updatedAt: meta.updatedAt || null };
}

function fileMeta(f) {
  return {
    id: f.id,
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.size || 0,
    uploadedAt: f.uploadedAt || null,
  };
}

// GET /api/materials — lista los 6 materiales (sin blobs)
app.get("/api/materials", wrap(async (_req, res) => {
  const out = [];
  for (const def of MATERIAL_DEFS) {
    const data = await readMaterial(def.key);
    const first = data.files[0] || null;
    out.push({
      key: def.key,
      title: def.title,
      kind: def.kind,
      hasFile: data.files.length > 0,
      filename: first?.filename || null,
      mimeType: first?.mimeType || null,
      size: first?.size || null,
      url: data.url || "",
      updatedAt: data.updatedAt || null,
      files: data.files.map(fileMeta),
      filesCount: data.files.length,
    });
  }
  res.json(out);
}));

// GET /api/materials/:key
app.get("/api/materials/:key", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  const data = await readMaterial(key);
  res.json({
    key: def.key,
    title: def.title,
    kind: def.kind,
    url: data.url || "",
    updatedAt: data.updatedAt || null,
    files: data.files.map(fileMeta),
  });
}));

// POST /api/materials/:key/upload — agrega un archivo (storage individual)
app.post("/api/materials/:key/upload", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  const { filename, mimeType, dataBase64 } = req.body || {};
  if (!dataBase64 || typeof dataBase64 !== "string") {
    return res.status(400).json({ message: "dataBase64 requerido" });
  }
  const cleaned = dataBase64.replace(/\s/g, "");
  const size = Math.floor((cleaned.length * 3) / 4) - (cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0);
  if (size > 50 * 1024 * 1024) {
    return res.status(413).json({ message: "archivo excede 50 MB" });
  }
  await migrateIfNeeded(key);
  const fileId = newFileId();
  const newFile = {
    filename: String(filename || (def.kind === "video" ? "video.mp4" : "documento.pdf")),
    mimeType: String(mimeType || (def.kind === "video" ? "video/mp4" : "application/pdf")),
    dataBase64: cleaned,
    size,
    uploadedAt: new Date().toISOString(),
  };
  // Escribir el archivo nuevo (1 fila independiente — no toca a los anteriores)
  await writeMaterialFile(key, fileId, newFile);
  // Actualizar meta agregando el fileId a la lista
  const meta = (await readMaterialMeta(key)) || { url: "", fileIds: [], updatedAt: null };
  meta.fileIds = [...meta.fileIds, fileId];
  meta.updatedAt = new Date().toISOString();
  await writeMaterialMeta(key, meta);
  res.json({ ok: true, key, file: fileMeta({ id: fileId, ...newFile }), filesCount: meta.fileIds.length });
}));

// PATCH /api/materials/:key/url
app.patch("/api/materials/:key/url", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  await migrateIfNeeded(key);
  const url = String(req.body?.url || "").trim();
  const meta = (await readMaterialMeta(key)) || { url: "", fileIds: [], updatedAt: null };
  meta.url = url;
  meta.updatedAt = new Date().toISOString();
  await writeMaterialMeta(key, meta);
  res.json({ ok: true, key, url });
}));

// DELETE /api/materials/:key/files/:fileId — borra un archivo individual
app.delete("/api/materials/:key/files/:fileId", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const fileId = String(req.params.fileId || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  await migrateIfNeeded(key);
  const meta = await readMaterialMeta(key);
  if (!meta || !meta.fileIds.includes(fileId)) {
    return res.status(404).json({ message: "archivo no encontrado" });
  }
  await deleteMaterialFile(key, fileId);
  meta.fileIds = meta.fileIds.filter((id) => id !== fileId);
  meta.updatedAt = new Date().toISOString();
  if (meta.fileIds.length === 0 && !meta.url) {
    await deleteMaterialMeta(key);
  } else {
    await writeMaterialMeta(key, meta);
  }
  res.json({ ok: true, key, fileId, filesCount: meta.fileIds.length });
}));

// DELETE /api/materials/:key/file — compat: borra TODOS los archivos
app.delete("/api/materials/:key/file", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  await migrateIfNeeded(key);
  const meta = await readMaterialMeta(key);
  const url = meta?.url || "";
  await deleteAllMaterialFiles(key);
  if (url) {
    await writeMaterialMeta(key, { url, fileIds: [], updatedAt: new Date().toISOString() });
  } else {
    await deleteMaterialMeta(key);
  }
  res.json({ ok: true, key });
}));

// GET /api/materials/:key/files/:fileId/download
app.get("/api/materials/:key/files/:fileId/download", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const fileId = String(req.params.fileId || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  await migrateIfNeeded(key);
  const file = await readMaterialFile(key, fileId);
  if (!file || !file.dataBase64) {
    return res.status(404).json({ message: "archivo no encontrado" });
  }
  try {
    const buf = Buffer.from(file.dataBase64, "base64");
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${(file.filename || key).replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ message: "error decodificando archivo", error: e?.message });
  }
}));

// GET /api/materials/:key/download — compat: sirve el PRIMER archivo
app.get("/api/materials/:key/download", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  await migrateIfNeeded(key);
  const meta = await readMaterialMeta(key);
  const firstId = meta?.fileIds?.[0];
  if (!firstId) return res.status(404).json({ message: "sin archivo subido" });
  const file = await readMaterialFile(key, firstId);
  if (!file || !file.dataBase64) {
    return res.status(404).json({ message: "sin archivo subido" });
  }
  try {
    const buf = Buffer.from(file.dataBase64, "base64");
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${(file.filename || key).replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ message: "error decodificando archivo", error: e?.message });
  }
}));

// ───── Dashboard de Ventas (resumen agregado) ──────────────
app.get("/api/sales/dashboard-summary", wrap(async (_req, res) => {
  const [leads, employees, partners, visits, maintOrders] = await Promise.all([
    readCol("erpLeads"),
    readCol("employees"),
    readCol("salesPartners"),
    readCol("erpVisits"),
    readCol("erpMaintenanceOrders"),
  ]);
  const now = new Date();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startYear = new Date(now.getFullYear(), 0, 1);
  const toNum = (v) => Number(v) || 0;
  const stageOf = (l) => String(l?.stage || l?.stageId || "").toLowerCase();
  const won = (l) => ["aprobada", "cerrada_ganada", "instalacion"].includes(stageOf(l));
  const lost = (l) => ["perdida", "cerrada_perdida"].includes(stageOf(l));
  const active = (l) => !won(l) && !lost(l);
  const amount = (l) => toNum(l?.amount || l?.totalAmount || l?.value || 0);
  const inDate = (d, start) => d && new Date(d) >= start;

  // KPIs hero
  const pipelineUsd = leads.filter(active).reduce((s, l) => s + amount(l), 0);
  const closedMonthUsd = leads.filter((l) => won(l) && inDate(l.closedAt || l.updatedAt, startMonth)).reduce((s, l) => s + amount(l), 0);
  const closedYearUsd = leads.filter((l) => won(l) && inDate(l.closedAt || l.updatedAt, startYear)).reduce((s, l) => s + amount(l), 0);
  const allClosed = leads.filter((l) => won(l) || lost(l)).length;
  const conversionRate = allClosed > 0 ? (leads.filter(won).length / allClosed) * 100 : 0;
  const activeLeadsCount = leads.filter(active).length;
  const todayStr = now.toISOString().slice(0, 10);
  const visitsToday = visits.filter((v) => String(v.scheduledDate || v.date || "").slice(0, 10) === todayStr).length;
  const pendingInspections = leads.filter((l) => stageOf(l) === "inspeccion_tecnica").length;

  // Embudo por etapa
  const stages = ["nuevo", "presentacion_corporativa", "inspeccion_tecnica", "cotizacion", "negociacion", "aprobada", "instalacion"];
  const funnel = stages.map((s) => ({
    stage: s,
    count: leads.filter((l) => stageOf(l) === s).length,
    amount: leads.filter((l) => stageOf(l) === s).reduce((sum, l) => sum + amount(l), 0),
  }));

  // Ranking vendedores (internos + partners) por USD cerrado este mes
  const sellerMap = new Map();
  for (const l of leads) {
    if (!won(l) || !inDate(l.closedAt || l.updatedAt, startMonth)) continue;
    const partnerId = l.salesPartnerId ? `p-${l.salesPartnerId}` : null;
    const empId = l.assigneeId ? `e-${l.assigneeId}` : null;
    const k = partnerId || empId;
    if (!k) continue;
    const prev = sellerMap.get(k) || { id: k, type: partnerId ? "partner" : "internal", closedUsd: 0, deals: 0 };
    prev.closedUsd += amount(l);
    prev.deals += 1;
    sellerMap.set(k, prev);
  }
  const ranking = Array.from(sellerMap.values())
    .map((r) => {
      let name = "", goal = 0;
      if (r.type === "partner") {
        const p = partners.find((x) => `p-${x.id}` === r.id);
        name = p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "Partner";
        goal = toNum(p?.monthlyGoalUsd);
      } else {
        const e = employees.find((x) => `e-${x.id}` === r.id);
        name = e ? `${e.firstName || ""} ${e.lastName || ""}`.trim() : "Vendedor";
        goal = toNum(e?.monthlySalesGoalUsd);
      }
      return { ...r, name, monthlyGoalUsd: goal, progressPct: goal > 0 ? Math.round((r.closedUsd / goal) * 100) : null };
    })
    .sort((a, b) => b.closedUsd - a.closedUsd)
    .slice(0, 5);

  // Rutas: contadores simples
  const routesVentas = new Set(leads.filter((l) => l.routeId && stageOf(l) !== "inspeccion_tecnica").map((l) => l.routeId)).size;
  const routesTecnicas = new Set(leads.filter((l) => l.routeId && stageOf(l) === "inspeccion_tecnica").map((l) => l.routeId)).size;

  // Actividad reciente: últimos 10 leads modificados
  const recent = [...leads]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
    .slice(0, 10)
    .map((l) => ({ id: l.id, name: l.name || l.clientName, stage: stageOf(l), amount: amount(l), updatedAt: l.updatedAt || l.createdAt, assigneeId: l.assigneeId, salesPartnerId: l.salesPartnerId }));

  res.json({
    pipelineUsd,
    closedMonthUsd,
    closedYearUsd,
    conversionRate,
    activeLeadsCount,
    visitsToday,
    pendingInspections,
    funnel,
    ranking,
    routesVentas,
    routesTecnicas,
    recent,
    totalsByType: {
      internal: ranking.filter((r) => r.type === "internal").length,
      partner: ranking.filter((r) => r.type === "partner").length,
    },
    generatedAt: now.toISOString(),
  });
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
