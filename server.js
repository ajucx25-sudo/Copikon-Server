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
  "/api/logistica/shipments-intl": "logShipmentsIntl",
  "/api/logistica/dispatches-nat": "logDispatchesNat",
  "/api/logistica/clients": "logClients",
  "/api/logistica/quotes": "logQuotes",
  "/api/logistica/rates": "logRates",
  "/api/logistica/carriers": "logCarriers",
  "/api/logistica/invoices": "logInvoices",
  "/api/logistica/payables": "logPayables",
  "/api/2bc/files": "twoBCFiles",
  "/api/2bc/clients": "twoBCClients",
  "/api/2bc/quotes": "twoBCQuotes",
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

// ───── Marketing · Materiales Corporativos ─────────────────
// Almacena PDFs/videos por material en la tabla `kv` bajo clave
// `material:<key>`. Cada material es:
//   { files: [{id, filename, mimeType, dataBase64, size, uploadedAt}],
//     url: string, updatedAt: string }
// Soporta múltiples archivos por material. Retrocompat con formato
// antiguo (un solo archivo en la raíz) vía normalización al leer.

const MATERIAL_DEFS = [
  { key: "presentacion_corporativa", title: "Presentación Corporativa", kind: "pdf" },
  { key: "catalogo_productos",       title: "Catálogo de Productos",   kind: "pdf" },
  { key: "brochure",                 title: "Brochure Institucional",   kind: "pdf" },
  { key: "casos_exito",              title: "Casos de Éxito / Referencias", kind: "pdf" },
  { key: "certificaciones",          title: "Certificaciones y Garantías",  kind: "pdf" },
  { key: "video_corporativo",        title: "Video Corporativo",        kind: "video" },
];

async function readMaterialRaw(key) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [`material:${key}`]);
  if (!r.rows[0]) return null;
  const v = r.rows[0].value;
  return v && typeof v === "object" ? v : null;
}

// Normaliza al esquema nuevo {files: [...], url, updatedAt}
// IMPORTANTE: si detectamos formato viejo (dataBase64 en la raíz), persistimos
// la migración a `files[]` para que el id sea estable. Antes generábamos un id
// mig-${Date.now()} en cada lectura, lo que rompía DELETE porque el id que vio
// el cliente ya no coincidía con el siguiente render del servidor.
async function readMaterial(key) {
  const raw = await readMaterialRaw(key);
  if (!raw) return { files: [], url: "", updatedAt: null };
  const files = Array.isArray(raw.files) ? [...raw.files] : [];
  let needsPersist = false;
  // Migración: si existía un archivo único en la raíz, lo movemos al array
  if (raw.dataBase64 && files.length === 0) {
    files.push({
      id: `mig-${Date.now()}`,
      filename: raw.filename || "documento.pdf",
      mimeType: raw.mimeType || "application/pdf",
      dataBase64: raw.dataBase64,
      size: raw.size || 0,
      uploadedAt: raw.updatedAt || new Date().toISOString(),
    });
    needsPersist = true;
  }
  // Asegurar id estable: si algún archivo no tiene id, asignar uno y persistir
  for (const f of files) {
    if (!f.id) {
      f.id = `mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      needsPersist = true;
    }
  }
  const updatedAt = raw.updatedAt || new Date().toISOString();
  if (needsPersist) {
    try {
      await writeMaterial(key, { files, url: raw.url || "", updatedAt });
    } catch (e) {
      console.warn(`[materials] no se pudo persistir migración de ${key}:`, e?.message || e);
    }
  }
  return { files, url: raw.url || "", updatedAt };
}

async function writeMaterial(key, data) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [`material:${key}`, JSON.stringify(data ?? {}), Date.now()]
  );
}

async function deleteMaterial(key) {
  await pool.query("DELETE FROM kv WHERE key = $1", [`material:${key}`]);
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

// GET /api/materials — lista los 6 materiales con su estado (sin blobs)
app.get("/api/materials", wrap(async (_req, res) => {
  const out = [];
  for (const def of MATERIAL_DEFS) {
    const data = await readMaterial(def.key);
    const first = data.files[0] || null;
    out.push({
      key: def.key,
      title: def.title,
      kind: def.kind,
      // Compat: campos del primer archivo en la raíz
      hasFile: data.files.length > 0,
      filename: first?.filename || null,
      mimeType: first?.mimeType || null,
      size: first?.size || null,
      url: data.url || "",
      updatedAt: data.updatedAt || null,
      // Nuevo: lista completa
      files: data.files.map(fileMeta),
      filesCount: data.files.length,
    });
  }
  res.json(out);
}));

// GET /api/materials/:key — detalle de un material con sus archivos (sin blobs)
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

// POST /api/materials/:key/upload — agrega un archivo (múltiples permitidos)
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
  const existing = await readMaterial(key);
  const newFile = {
    id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: String(filename || (def.kind === "video" ? "video.mp4" : "documento.pdf")),
    mimeType: String(mimeType || (def.kind === "video" ? "video/mp4" : "application/pdf")),
    dataBase64: cleaned,
    size,
    uploadedAt: new Date().toISOString(),
  };
  const updated = {
    files: [...existing.files, newFile],
    url: existing.url || "",
    updatedAt: new Date().toISOString(),
  };
  await writeMaterial(key, updated);
  res.json({ ok: true, key, file: fileMeta(newFile), filesCount: updated.files.length });
}));

// PATCH /api/materials/:key/url — guarda enlace externo
app.patch("/api/materials/:key/url", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  const url = String(req.body?.url || "").trim();
  const existing = await readMaterial(key);
  const updated = { files: existing.files, url, updatedAt: new Date().toISOString() };
  await writeMaterial(key, updated);
  res.json({ ok: true, key, url });
}));

// DELETE /api/materials/:key/files/:fileId — borra un archivo específico
app.delete("/api/materials/:key/files/:fileId", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const fileId = String(req.params.fileId || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  const existing = await readMaterial(key);
  const next = existing.files.filter((f) => f.id !== fileId);
  if (next.length === existing.files.length) {
    return res.status(404).json({ message: "archivo no encontrado" });
  }
  const url = existing.url || "";
  if (next.length === 0 && !url) {
    await deleteMaterial(key);
  } else {
    await writeMaterial(key, { files: next, url, updatedAt: new Date().toISOString() });
  }
  res.json({ ok: true, key, fileId, filesCount: next.length });
}));

// DELETE /api/materials/:key/file — compat: borra TODOS los archivos
app.delete("/api/materials/:key/file", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  const existing = await readMaterial(key);
  const url = existing.url || "";
  if (url) {
    await writeMaterial(key, { files: [], url, updatedAt: new Date().toISOString() });
  } else {
    await deleteMaterial(key);
  }
  res.json({ ok: true, key });
}));

// GET /api/materials/:key/files/:fileId/download — sirve un archivo específico
app.get("/api/materials/:key/files/:fileId/download", wrap(async (req, res) => {
  const key = String(req.params.key || "");
  const fileId = String(req.params.fileId || "");
  const def = MATERIAL_DEFS.find((d) => d.key === key);
  if (!def) return res.status(404).json({ message: "material no existe" });
  const data = await readMaterial(key);
  const file = data.files.find((f) => f.id === fileId);
  if (!file || !file.dataBase64) {
    return res.status(404).json({ message: "archivo no encontrado" });
  }
  try {
    const buf = Buffer.from(file.dataBase64, "base64");
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename=\"${(file.filename || key).replace(/"/g, "")}\"`);
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
  const data = await readMaterial(key);
  const file = data.files[0];
  if (!file || !file.dataBase64) {
    return res.status(404).json({ message: "sin archivo subido" });
  }
  try {
    const buf = Buffer.from(file.dataBase64, "base64");
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename=\"${(file.filename || key).replace(/"/g, "")}\"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ message: "error decodificando archivo", error: e?.message });
  }
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
