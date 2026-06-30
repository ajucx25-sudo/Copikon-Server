// ============================================================
// Copikon Backend ligero — Express + Postgres
// ============================================================
// Modelo: una tabla `kv` con (key TEXT PRIMARY KEY, value JSONB).
// Cada colección (employees, projects, projectTasks, erpProducts, …)
// se guarda como un array JSON bajo su clave. La API expone CRUD
// genérico compatible con las rutas /api/... que ya usa el frontend.
// ============================================================

import express from "express";
import compression from "compression";
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
  // Infraestructura y Mantenimiento Corporativo v1
  "/api/erp/infra-assets": "infraAssets",
  "/api/erp/infra-maintenance-plans": "infraMaintenancePlans",
  "/api/erp/infra-maintenance-orders": "infraMaintenanceOrders",
  "/api/erp/infra-incidents": "infraIncidents",
  "/api/erp/infra-transfers": "infraTransfers",
  // Pre-Leads (carga masiva antes de convertir a lead)
  "/api/erp/pre-leads": "preLeads",
  // Notificaciones in-app y reportes semanales de bitácora
  "/api/notifications": "notifications",
  "/api/bitacora-reports": "bitacoraReports",
  // Operaciones → Abastecimiento (catálogo de sucursales, parámetros min/max y propuestas semanales)
  "/api/abastecimiento/sucursales": "abastecimientoSucursales",
  "/api/abastecimiento/sku-params": "abastecimientoSkuParams",
  "/api/abastecimiento/propuestas": "abastecimientoPropuestas",
  "/api/abastecimiento/odoo-config": "abastecimientoOdooConfig",
  "/api/abastecimiento/odoo-stock": "abastecimientoOdooStock",
  "/api/abastecimiento/odoo-products": "abastecimientoOdooProducts",
  // Min/Max oficial (base inicial cargada del Excel 2026-06-23, recálculo automático desde Odoo stock.move 12m)
  "/api/abastecimiento/minmax": "abastecimientoMinMax",
};

const STATIC_KEYS = ["departments", "announcements", "jobDescriptions", "processMaps", "courses"];

const app = express();
app.use(compression({ level: 6, threshold: 1024 })); // gzip — reduce respuestas JSON ~70%
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

// ───── Tarifario de Alquiler (singleton key-value) ─────────
// Guarda un objeto (no array) en kv bajo la clave 'rentalTariff'
async function readSingleton(key) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  if (!r.rows[0]) return null;
  return r.rows[0].value;
}
async function writeSingleton(key, obj) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(obj ?? {}), Date.now()]
  );
}

const DEFAULT_RENTAL_TARIFF = {
  pricePerKvaPerDay: 1.5,
  weeklyDiscountPct: 10,
  monthlyDiscountPct: 25,
  lightTowerPricePerDay: 45,
  transportFlatFee: 50,
  transportPerKm: 0.8,
  fuelPricePerLiter: 1.2,
  fuelDefaultMode: "dry",
  operatorPerDay: 60,
  depositPctOfMonthly: 50,
  currency: "USD",
  notes: "",
};

app.get("/api/erp/rental-tariff", wrap(async (_req, res) => {
  const t = await readSingleton("rentalTariff");
  res.json(t && typeof t === "object" && !Array.isArray(t) ? t : DEFAULT_RENTAL_TARIFF);
}));

app.put("/api/erp/rental-tariff", wrap(async (req, res) => {
  const body = req.body || {};
  const merged = { ...DEFAULT_RENTAL_TARIFF, ...body, updatedAt: new Date().toISOString() };
  await writeSingleton("rentalTariff", merged);
  res.json(merged);
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

// ───── Abastecimiento bulk-replace (DEBE ir antes del CRUD genérico para no chocar con :id) ─────
const ABASTECIMIENTO_BULK_MAP = {
  "sucursales": "abastecimientoSucursales",
  "sku-params": "abastecimientoSkuParams",
  "propuestas": "abastecimientoPropuestas",
  "odoo-config": "abastecimientoOdooConfig",
};
app.put("/api/abastecimiento/:segment/bulk-replace", wrap(async (req, res) => {
  const key = ABASTECIMIENTO_BULK_MAP[req.params.segment];
  if (!key) return res.status(404).json({ error: "key inválida" });
  const body = req.body;
  if (!Array.isArray(body)) return res.status(400).json({ error: "se requiere array" });
  await writeCol(key, body);
  res.json({ ok: true, count: body.length });
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
  { key: "brochure",                 title: "Brochure de Generadores",   kind: "pdf" },
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

// ─────────────────────────────────────────────────────────────
// RSI Global (Wialon) — proxy seguro para dashboard de flota GPS
// Mantiene un sid de sesión en cache; re-autentica si caduca.
// Credenciales en env vars RSI_USER / RSI_PASS — nunca en frontend.
// ─────────────────────────────────────────────────────────────
const RSI_USER = process.env.RSI_USER;
const RSI_PASS = process.env.RSI_PASS;
const WIALON_HOST = "https://hst-api.wialon.com";

let wialonSid = null;
let wialonSidExpiresAt = 0; // ms

async function wialonLogin() {
  // Wialon Hosting requiere token de aplicación (no user/password)
  // trim() para tolerar espacios o saltos de línea al pegar en Render
  const token = (process.env.RSI_TOKEN || "").trim();
  if (!token) {
    throw new Error("RSI_TOKEN env var no configurado");
  }
  const params = { token };
  const url = `${WIALON_HOST}/wialon/ajax.html?svc=token/login&params=${encodeURIComponent(JSON.stringify(params))}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error || !data.eid) {
    throw new Error(`Wialon login falló: ${JSON.stringify(data)}`);
  }
  wialonSid = data.eid;
  // Wialon mantiene la sesión activa por ~5 min de inactividad; refrescamos cada 4 min
  wialonSidExpiresAt = Date.now() + 4 * 60 * 1000;
  return wialonSid;
}

async function wialonCall(svc, params) {
  if (!wialonSid || Date.now() > wialonSidExpiresAt) {
    await wialonLogin();
  }
  const url = `${WIALON_HOST}/wialon/ajax.html?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}&sid=${wialonSid}`;
  const res = await fetch(url);
  const data = await res.json();
  // Si el sid expiró, re-loguear y reintentar una vez
  if (data.error === 1 || data.error === 5) {
    await wialonLogin();
    const url2 = `${WIALON_HOST}/wialon/ajax.html?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}&sid=${wialonSid}`;
    const res2 = await fetch(url2);
    return res2.json();
  }
  // Cada llamada exitosa extiende la vida del sid
  wialonSidExpiresAt = Date.now() + 4 * 60 * 1000;
  return data;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Cache de unidades — 30 s para no martillar la API
let unitsCache = null;
let unitsCacheAt = 0;

async function getUnits() {
  if (unitsCache && Date.now() - unitsCacheAt < 30 * 1000) return unitsCache;
  const data = await wialonCall("core/search_items", {
    spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
    force: 1,
    flags: 1 + 8 + 256 + 1024, // base + lastMessage + position + sensors
    from: 0,
    to: 0,
  });
  const items = (data.items || []).map((u) => {
    const lastReportSec = u.lmsg?.t || 0;
    const minsSinceReport = lastReportSec ? Math.floor((Date.now() / 1000 - lastReportSec) / 60) : null;
    return {
      id: u.id,
      name: u.nm,
      iconUrl: u.uri ? `${WIALON_HOST}${u.uri}?b=${u.bact || 0}` : null,
      position: u.pos
        ? { lat: u.pos.y, lng: u.pos.x, speed: u.pos.s, course: u.pos.c, altitude: u.pos.z, satellites: u.pos.sc }
        : null,
      lastReportAt: lastReportSec ? new Date(lastReportSec * 1000).toISOString() : null,
      minutesSinceReport: minsSinceReport,
      status: !lastReportSec
        ? "sin_reporte"
        : minsSinceReport > 60
        ? "sin_reporte"
        : (u.pos?.s || 0) > 5
        ? "en_movimiento"
        : "detenido",
    };
  });
  unitsCache = { count: items.length, items, fetchedAt: new Date().toISOString() };
  unitsCacheAt = Date.now();
  return unitsCache;
}

// Cache por unidad para los datos del día — 60 s
const todayCache = new Map();

async function getUnitToday(unitId) {
  const cached = todayCache.get(unitId);
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.data;

  const now = Math.floor(Date.now() / 1000);
  const startOfDay = Math.floor(new Date(new Date().toDateString()).getTime() / 1000);

  const data = await wialonCall("messages/load_interval", {
    itemId: unitId,
    timeFrom: startOfDay,
    timeTo: now,
    flags: 0,
    flagsMask: 0,
    loadCount: 10000,
  });

  let totalKm = 0;
  let maxSpeed = 0;
  let movingSec = 0;
  let stoppedSec = 0;
  let lastPos = null;
  let lastTime = null;
  const track = [];
  const positions = (data.messages || []).filter((m) => m.pos);
  positions.forEach((m) => {
    if (lastPos) {
      const km = haversineKm(lastPos.y, lastPos.x, m.pos.y, m.pos.x);
      totalKm += km;
      const dt = m.t - lastTime;
      if (m.pos.s > 0) movingSec += dt;
      else stoppedSec += dt;
    }
    if (m.pos.s > maxSpeed) maxSpeed = m.pos.s;
    lastPos = m.pos;
    lastTime = m.t;
    // Track: muestreamos cada N para no devolver 1000 puntos
  });

  // Track reducido: máximo 200 puntos para el mapa
  const step = Math.max(1, Math.floor(positions.length / 200));
  for (let i = 0; i < positions.length; i += step) {
    const m = positions[i];
    track.push({ t: m.t, lat: m.pos.y, lng: m.pos.x, speed: m.pos.s });
  }

  const result = {
    unitId,
    date: new Date(startOfDay * 1000).toISOString().slice(0, 10),
    totalKm: Number(totalKm.toFixed(2)),
    maxSpeed,
    movingMinutes: Math.round(movingSec / 60),
    stoppedMinutes: Math.round(stoppedSec / 60),
    messageCount: positions.length,
    track,
  };
  todayCache.set(unitId, { data: result, at: Date.now() });
  return result;
}

// Endpoint de diagnóstico — muestra qué env vars relacionadas con RSI ve el server
app.get("/api/rsi/_debug", wrap(async (_req, res) => {
  const allEnvKeys = Object.keys(process.env);
  const rsiKeys = allEnvKeys.filter((k) => k.toUpperCase().includes("RSI") || k.toUpperCase().includes("WIALON"));
  res.json({
    rsiTokenSet: !!process.env.RSI_TOKEN,
    rsiTokenLength: (process.env.RSI_TOKEN || "").length,
    rsiUserSet: !!process.env.RSI_USER,
    rsiUserLength: (process.env.RSI_USER || "").length,
    rsiPassSet: !!process.env.RSI_PASS,
    rsiPassLength: (process.env.RSI_PASS || "").length,
    relatedKeys: rsiKeys,
    nodeVersion: process.version,
    totalEnvCount: allEnvKeys.length,
    sampleNonSecretKeys: allEnvKeys.filter((k) => !k.toLowerCase().match(/pass|secret|token|key|auth/)).slice(0, 30),
  });
}));

app.get("/api/rsi/units", wrap(async (_req, res) => {
  try {
    const data = await getUnits();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}));

app.get("/api/rsi/unit/:id/today", wrap(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await getUnitToday(id);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}));

app.get("/api/rsi/fleet/summary", wrap(async (_req, res) => {
  try {
    const units = await getUnits();
    const enMovimiento = units.items.filter((u) => u.status === "en_movimiento").length;
    const detenido = units.items.filter((u) => u.status === "detenido").length;
    const sinReporte = units.items.filter((u) => u.status === "sin_reporte").length;

    // Sumar km del día de todas las unidades activas
    const activeUnits = units.items.filter((u) => u.status !== "sin_reporte");
    const todayData = await Promise.all(
      activeUnits.map((u) => getUnitToday(u.id).catch(() => null))
    );
    const totalKmToday = todayData.filter(Boolean).reduce((sum, d) => sum + (d.totalKm || 0), 0);
    const totalMovingMin = todayData.filter(Boolean).reduce((sum, d) => sum + (d.movingMinutes || 0), 0);

    res.json({
      totalUnits: units.count,
      enMovimiento,
      detenido,
      sinReporte,
      totalKmToday: Number(totalKmToday.toFixed(2)),
      totalMovingMinutes: totalMovingMin,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}));

// ───── Arranque ─────────────────────────────────────────────
// Bitacora Generators - Recordatorios y Reportes Semanales
const BITACORA_MODULE_PREFIX = "gen-";

function caracasNow() {
  return new Date(Date.now() - 4 * 60 * 60 * 1000);
}

function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

async function getBitacoraRecipients() {
  const employees = await readCol("employees");
  const ceo = employees.find((e) => e && (e.level === "ceo" || e.username === "admin"));
  const generatorsManager = employees.find(
    (e) => e && Number(e.departmentId) === 31 && (e.level === "manager" || e.level === "gerente")
  );
  const managers = employees.filter((e) => e && (e.level === "manager" || e.level === "ceo"));
  return { ceo, generatorsManager, directiva: managers };
}

async function pushNotification({ userId, title, message, type = "info", link = null }) {
  if (!userId) return null;
  const items = await readCol("notifications");
  const nextId = items.reduce((m, it) => Math.max(m, Number(it?.id) || 0), 0) + 1;
  const notif = {
    id: nextId,
    userId: Number(userId),
    title,
    message,
    type,
    link,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  items.push(notif);
  const trimmed = items.length > 500 ? items.slice(-500) : items;
  await writeCol("notifications", trimmed);
  return notif;
}

app.post("/api/generators/bitacora/check-daily", wrap(async (_req, res) => {
  const caracasToday = caracasNow();
  const yesterday = new Date(caracasToday.getTime() - 24 * 60 * 60 * 1000);
  const yDateStr = yesterday.toISOString().slice(0, 10);

  if (!isWeekday(yesterday)) {
    return res.json({ ok: true, skipped: true, reason: "yesterday-was-weekend", date: yDateStr });
  }

  const activities = await readCol("copikonGenActivities");
  const yActivities = (activities || []).filter((a) => {
    if (!a || a.type !== "bitacora") return false;
    if (typeof a.module !== "string" || !a.module.startsWith(BITACORA_MODULE_PREFIX)) return false;
    const dates = [a.createdAt, a.startDate, a.completedDate, a.dueDate].filter(Boolean);
    return dates.some((d) => String(d).slice(0, 10) === yDateStr);
  });

  if (yActivities.length > 0) {
    return res.json({
      ok: true,
      skipped: true,
      reason: "activities-found",
      date: yDateStr,
      count: yActivities.length,
    });
  }

  const { ceo, generatorsManager } = await getBitacoraRecipients();
  const sent = [];
  const ddmm = yDateStr.split("-").reverse().slice(0, 2).join("/");
  const title = `Sin actividades en bitacora (${ddmm})`;
  const message = `No se registro ninguna actividad en la bitacora de Copikon Generators el dia ${ddmm}. Por favor verificar con los responsables.`;
  const link = "/copikon-generators?module=bitacora";

  if (ceo) {
    const n = await pushNotification({ userId: ceo.id, title, message, type: "warning", link });
    sent.push({ userId: ceo.id, who: "ceo", id: n?.id });
  }
  if (generatorsManager && generatorsManager.id !== ceo?.id) {
    const n = await pushNotification({ userId: generatorsManager.id, title, message, type: "warning", link });
    sent.push({ userId: generatorsManager.id, who: "gerente-generators", id: n?.id });
  }

  res.json({ ok: true, date: yDateStr, recipients: sent });
}));

app.post("/api/generators/bitacora/generate-weekly-report", wrap(async (_req, res) => {
  const caracas = caracasNow();
  const dow = caracas.getUTCDay();
  const monday = new Date(caracas);
  const diffToMon = (dow === 0 ? 6 : dow - 1);
  monday.setUTCDate(caracas.getUTCDate() - diffToMon);
  monday.setUTCHours(0, 0, 0, 0);
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  friday.setUTCHours(23, 59, 59, 999);

  const fromStr = monday.toISOString().slice(0, 10);
  const toStr = friday.toISOString().slice(0, 10);

  const [activities, employees] = await Promise.all([
    readCol("copikonGenActivities"),
    readCol("employees"),
  ]);

  const inWeek = (a) => {
    const candidates = [a.createdAt, a.startDate, a.completedDate, a.dueDate].filter(Boolean);
    return candidates.some((d) => {
      const s = String(d).slice(0, 10);
      return s >= fromStr && s <= toStr;
    });
  };

  const weekActivities = (activities || []).filter(
    (a) =>
      a && a.type === "bitacora" &&
      typeof a.module === "string" &&
      a.module.startsWith(BITACORA_MODULE_PREFIX) &&
      inWeek(a)
  );

  const totalActivities = weekActivities.length;
  const completadas = weekActivities.filter((a) => a.status === "completada").length;
  const enProgreso = weekActivities.filter((a) => a.status === "en_progreso").length;
  const pendientes = weekActivities.filter((a) => a.status === "pendiente").length;
  const altaPrioridad = weekActivities.filter((a) => a.priority === "alta").length;

  const byModule = {};
  for (const a of weekActivities) {
    const m = a.module;
    if (!byModule[m]) byModule[m] = { total: 0, completadas: 0, enProgreso: 0, pendientes: 0, items: [] };
    byModule[m].total++;
    if (a.status === "completada") byModule[m].completadas++;
    else if (a.status === "en_progreso") byModule[m].enProgreso++;
    else if (a.status === "pendiente") byModule[m].pendientes++;
    const emp = employees.find((e) => Number(e.id) === Number(a.assigneeId));
    byModule[m].items.push({
      id: a.id,
      title: a.title,
      description: a.description,
      status: a.status,
      priority: a.priority,
      assignee: emp ? `${emp.firstName} ${emp.lastName}`.trim() : null,
      createdAt: a.createdAt,
      completedDate: a.completedDate,
      dueDate: a.dueDate,
    });
  }

  // byAssignee indexado por employeeId (clave numérica) para que el frontend pueda hacer lookup
  const byAssignee = {};
  for (const a of weekActivities) {
    if (!a.assigneeId) continue;
    const emp = employees.find((e) => Number(e.id) === Number(a.assigneeId));
    if (!emp) continue;
    const key = String(emp.id);
    const name = `${emp.firstName} ${emp.lastName}`.trim();
    if (!byAssignee[key]) byAssignee[key] = { total: 0, completadas: 0, nombre: name };
    byAssignee[key].total++;
    if (a.status === "completada") byAssignee[key].completadas++;
  }

  const report = {
    id: Date.now(),
    weekStart: fromStr,
    weekEnd: toStr,
    generatedAt: new Date().toISOString(),
    stats: {
      totalActivities,
      completadas,
      enProgreso,
      pendientes,
      altaPrioridad,
      completionRate: totalActivities > 0 ? Math.round((completadas / totalActivities) * 100) : 0,
    },
    byModule,
    byAssignee,
    activities: weekActivities,
  };

  const reports = await readCol("bitacoraReports");
  const existingIdx = reports.findIndex((r) => r.weekStart === fromStr);
  if (existingIdx >= 0) {
    reports[existingIdx] = report;
  } else {
    reports.push(report);
  }
  const trimmed = reports.length > 52 ? reports.slice(-52) : reports;
  await writeCol("bitacoraReports", trimmed);

  const { ceo, generatorsManager, directiva } = await getBitacoraRecipients();
  const recipients = new Map();
  if (ceo) recipients.set(ceo.id, { who: "ceo", emp: ceo });
  if (generatorsManager) recipients.set(generatorsManager.id, { who: "gerente-generators", emp: generatorsManager });
  for (const m of directiva) recipients.set(m.id, { who: "directiva", emp: m });

  const fmtDdMm = (s) => s.split("-").reverse().slice(0, 2).join("/");
  const title = `Reporte semanal bitacora (${fmtDdMm(fromStr)} - ${fmtDdMm(toStr)})`;
  const message = `Disponible el reporte de bitacora de Copikon Generators de la semana. Total: ${totalActivities} actividades, ${completadas} completadas (${report.stats.completionRate}%), ${enProgreso} en progreso, ${pendientes} pendientes.`;
  const link = `/copikon-generators?module=bitacora&report=${report.id}`;

  const sent = [];
  for (const [userId, info] of recipients.entries()) {
    const n = await pushNotification({ userId, title, message, type: "info", link });
    sent.push({ userId, who: info.who, id: n?.id });
  }

  res.json({ ok: true, report, recipients: sent });
}));

app.post("/api/notifications/:id/read", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const items = await readCol("notifications");
  const idx = items.findIndex((x) => Number(x.id) === id);
  if (idx < 0) return res.status(404).json({ message: "not found" });
  items[idx] = { ...items[idx], readAt: new Date().toISOString() };
  await writeCol("notifications", items);
  res.json(items[idx]);
}));

app.post("/api/notifications/read-all", wrap(async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!userId) return res.status(400).json({ message: "userId requerido" });
  const items = await readCol("notifications");
  const now = new Date().toISOString();
  let updated = 0;
  for (let i = 0; i < items.length; i++) {
    if (Number(items[i].userId) === userId && !items[i].readAt) {
      items[i] = { ...items[i], readAt: now };
      updated++;
    }
  }
  await writeCol("notifications", items);
  res.json({ ok: true, updated });
}));

// ============================================================================
// OPERACIONES → ABASTECIMIENTO
// ----------------------------------------------------------------------------
// Genera la propuesta semanal de reabastecimiento por sucursal a partir de:
//   - Catálogo de sucursales (kv: abastecimientoSucursales)
//   - Parámetros min/max/óptimo por SKU×sucursal (kv: abastecimientoSkuParams)
//   - Inventario actual por sucursal (Odoo si está conectado, fallback a kv local)
//
// Fórmula confirmada por el usuario (29-jun-2026):
//   max_dias = 60
//   margen_seguridad = 20%
//   lead_time = 30 días
//   Min = Venta_diaria * (lead_time) * (1 + margen)
//   Max = Venta_diaria * max_dias
//   Optimo = (Min + Max) / 2
//   Sugerido = max(0, Optimo - Stock_actual)
// ============================================================================

function calcMinMaxOptimo({ ventaDiaria = 0, leadTime = 30, maxDias = 60, margen = 0.20 }) {
  const v = Number(ventaDiaria) || 0;
  const min = Math.round(v * leadTime * (1 + margen));
  const max = Math.round(v * maxDias);
  const opt = Math.round((min + max) / 2);
  return { min, max, optimo: opt };
}

// POST /api/abastecimiento/generar-propuesta { sucursalId } → crea propuesta automática
app.post("/api/abastecimiento/generar-propuesta", wrap(async (req, res) => {
  const { sucursalId } = req.body || {};
  if (!sucursalId) return res.status(400).json({ error: "sucursalId requerido" });

  const sucursales = await readCol("abastecimientoSucursales").catch(() => []);
  const sucursal = (sucursales || []).find((s) => String(s.id) === String(sucursalId));
  if (!sucursal) return res.status(404).json({ error: "Sucursal no encontrada" });

  const skuParams = await readCol("abastecimientoSkuParams").catch(() => []);
  const productos = await readCol("erpProducts").catch(() => []);

  // Construir líneas: para cada parámetro de esta sucursal, calcular sugerido.
  // Si existe el producto en erpProducts lo usamos para metadata; si no, usamos los datos del param.
  const lineas = [];
  for (const param of skuParams) {
    if (String(param.sucursalId) !== String(sucursalId)) continue;
    const producto = productos.find((p) => String(p.id) === String(param.productoId) || String(p.sku) === String(param.sku));
    const { min, max, optimo } = calcMinMaxOptimo({
      ventaDiaria: param.ventaDiaria || 0,
      leadTime: param.leadTime || 30,
      maxDias: param.maxDias || 60,
      margen: typeof param.margen === "number" ? param.margen : 0.20,
    });
    const stockActual = Number(param.stockActual || 0);
    const sugerido = Math.max(0, optimo - stockActual);
    if (sugerido <= 0 && stockActual >= min) continue; // no necesita reposición
    lineas.push({
      productoId: producto ? producto.id : (param.productoId || null),
      sku: (producto && producto.sku) || param.sku || "",
      nombre: (producto && (producto.name || producto.nombre)) || param.nombre || "",
      stockActual,
      min, max, optimo,
      sugerido,
      criticidad: stockActual < min ? "critica" : stockActual < optimo ? "baja" : "ok",
    });
  }

  // Crear propuesta
  const propuestas = await readCol("abastecimientoPropuestas").catch(() => []);
  const newId = Date.now();
  const nuevaPropuesta = {
    id: newId,
    sucursalId,
    sucursalNombre: sucursal.nombre,
    fechaGenerada: new Date().toISOString(),
    fechaDespacho: sucursal.proximoDespacho || null,
    estado: "pendiente", // pendiente → aprobada → despachada → rechazada
    lineas,
    totales: {
      totalSkus: lineas.length,
      totalUnidades: lineas.reduce((s, l) => s + l.sugerido, 0),
      criticas: lineas.filter((l) => l.criticidad === "critica").length,
    },
    formula: { maxDias: 60, leadTime: 30, margen: 0.20 },
  };
  propuestas.push(nuevaPropuesta);
  await writeCol("abastecimientoPropuestas", propuestas);
  res.json({ ok: true, propuesta: nuevaPropuesta });
}));

// POST /api/abastecimiento/odoo-sync → sincroniza inventario desde Odoo
// Si la configuración no está lista, devuelve un mensaje claro al frontend.
app.post("/api/abastecimiento/odoo-sync", wrap(async (_req, res) => {
  // odooConfig se guarda como array de 1 elemento por compatibilidad con readCol
  try {
    const result = await runOdooSync();
    res.json(result);
  } catch (e) {
    console.error("[odoo-sync] error:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}));

// POST /api/abastecimiento/odoo-test — prueba credenciales y devuelve info del servidor
app.post("/api/abastecimiento/odoo-test", wrap(async (_req, res) => {
  try {
    const cfg = await readOdooConfig();
    if (!cfg) {
      return res.json({ ok: false, message: "Conexión Odoo no configurada. Completa los campos antes de probar." });
    }
    const odoo = await odooConnect(cfg);
    // Contar warehouses, products almacenables, y user info
    const userInfo = await odoo.execute_kw("res.users", "read", [[odoo.uid], ["name", "login"]]);
    const warehouses = await odoo.execute_kw("stock.warehouse", "search_read", [[], ["id", "name", "code"]]);
    const productsCount = await odoo.execute_kw("product.product", "search_count", [[["type", "=", "product"]]]);
    res.json({
      ok: true,
      message: "Conexión exitosa",
      info: {
        user: userInfo[0]?.name || cfg.username,
        login: userInfo[0]?.login || cfg.username,
        warehouses: warehouses.map(w => ({ id: w.id, name: w.name, code: w.code })),
        productosAlmacenables: productsCount,
      }
    });
  } catch (e) {
    console.error("[odoo-test] error:", e?.message || e);
    res.json({ ok: false, message: String(e?.message || e) });
  }
}));

// ───── Odoo XML-RPC helpers (sin dependencias — fetch nativo + XML manual) ─────
async function readOdooConfig() {
  const cfgArr = await readCol("abastecimientoOdooConfig").catch(() => []);
  const cfg = (Array.isArray(cfgArr) && cfgArr[0]) || {};
  if (!cfg.url || !cfg.db || !cfg.username || !cfg.password) return null;
  return cfg;
}

// Serializa un valor JS a XML-RPC <value>
function xrpcValue(v) {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return `<value><int>${v}</int></value>`;
    return `<value><double>${v}</double></value>`;
  }
  if (typeof v === "string") return `<value><string>${escapeXml(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(xrpcValue).join("")}</data></array></value>`;
  }
  if (typeof v === "object") {
    const members = Object.entries(v).map(([k, val]) =>
      `<member><name>${escapeXml(k)}</name>${xrpcValue(val)}</member>`
    ).join("");
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escapeXml(String(v))}</string></value>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildXrpcRequest(methodName, params) {
  const paramsXml = params.map(p => `<param>${xrpcValue(p)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName><params>${paramsXml}</params></methodCall>`;
}

// Parser muy simple de XML-RPC respuesta (suficiente para Odoo)
function parseXrpcResponse(xml) {
  // Detectar fault
  const faultMatch = xml.match(/<fault>([\s\S]*?)<\/fault>/);
  if (faultMatch) {
    const stringMatch = faultMatch[1].match(/<string>([\s\S]*?)<\/string>/);
    const intMatch = faultMatch[1].match(/<int>([\s\S]*?)<\/int>/);
    const msg = stringMatch ? unescapeXml(stringMatch[1]) : (intMatch ? `Fault ${intMatch[1]}` : "XML-RPC fault");
    const err = new Error(msg);
    err.isFault = true;
    throw err;
  }
  const valMatch = xml.match(/<params>\s*<param>([\s\S]*?)<\/param>\s*<\/params>/);
  if (!valMatch) {
    throw new Error("Respuesta XML-RPC sin <params>");
  }
  return parseValueNode(valMatch[1]);
}

function unescapeXml(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Parsea un nodo <value>...</value> a JS
function parseValueNode(chunk) {
  // chunk puede o no incluir el wrapper <value>...
  const trimmed = chunk.replace(/^\s*<value>/, "").replace(/<\/value>\s*$/, "").trim();
  if (trimmed.startsWith("<array>")) {
    const inner = trimmed.slice("<array>".length, -"</array>".length).replace(/^<data>/, "").replace(/<\/data>$/, "");
    return splitTopLevelValues(inner).map(parseValueNode);
  }
  if (trimmed.startsWith("<struct>")) {
    const inner = trimmed.slice("<struct>".length, -"</struct>".length);
    const out = {};
    const memberRegex = /<member>\s*<name>([\s\S]*?)<\/name>\s*([\s\S]*?)<\/member>/g;
    let m;
    while ((m = memberRegex.exec(inner)) !== null) {
      out[unescapeXml(m[1])] = parseValueNode(m[2]);
    }
    return out;
  }
  if (trimmed.startsWith("<int>")) return parseInt(trimmed.slice(5, -6), 10);
  if (trimmed.startsWith("<i4>")) return parseInt(trimmed.slice(4, -5), 10);
  if (trimmed.startsWith("<boolean>")) return trimmed.slice(9, -10) === "1";
  if (trimmed.startsWith("<double>")) return parseFloat(trimmed.slice(8, -9));
  if (trimmed.startsWith("<string>")) return unescapeXml(trimmed.slice(8, -9));
  if (trimmed.startsWith("<dateTime.iso8601>")) return unescapeXml(trimmed.slice(18, -19));
  if (trimmed.startsWith("<base64>")) return trimmed.slice(8, -9);
  if (trimmed.startsWith("<nil/>")) return null;
  if (trimmed === "" || trimmed.startsWith("<nil")) return null;
  // String puro (si Odoo no envuelve)
  return unescapeXml(trimmed);
}

// Divide un bloque XML en sus <value>...</value> top-level
function splitTopLevelValues(inner) {
  const out = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  const len = inner.length;
  while (i < len) {
    if (inner[i] === "<") {
      const close = inner.indexOf(">", i);
      if (close < 0) break;
      const tag = inner.substring(i + 1, close);
      const isClose = tag.startsWith("/");
      const isSelfClose = tag.endsWith("/");
      const tagName = (isClose ? tag.slice(1) : tag).split(/[ \/]/)[0];
      if (tagName === "value") {
        if (isClose) {
          depth--;
          if (depth === 0 && start >= 0) {
            out.push(inner.substring(start, close + 1));
            start = -1;
          }
        } else if (!isSelfClose) {
          if (depth === 0) start = i;
          depth++;
        }
      }
      i = close + 1;
    } else {
      i++;
    }
  }
  return out;
}

async function odooXrpc(url, methodName, params, timeoutMs = 60000) {
  const xmlBody = buildXrpcRequest(methodName, params);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: xmlBody,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return parseXrpcResponse(text);
  } finally {
    clearTimeout(t);
  }
}

async function odooConnect(cfg) {
  const baseUrl = String(cfg.url).replace(/\/$/, "");
  const commonUrl = baseUrl + "/xmlrpc/2/common";
  const objectUrl = baseUrl + "/xmlrpc/2/object";
  const uid = await odooXrpc(commonUrl, "authenticate", [cfg.db, cfg.username, cfg.password, {}]);
  if (!uid || uid === false) {
    throw new Error("Autenticación fallida. Verifica URL, BD, usuario y API Key en la pestaña Odoo.");
  }
  return {
    uid,
    cfg,
    async execute_kw(model, method, args, kwargs = {}) {
      return odooXrpc(objectUrl, "execute_kw", [cfg.db, uid, cfg.password, model, method, args, kwargs]);
    }
  };
}

// Sincroniza warehouses + productos + stock por sucursal
// Guarda en kv: abastecimientoOdooStock = [{sucursalId, warehouseId, sku, productId, qty, lastUpdate}]
async function runOdooSync() {
  const cfg = await readOdooConfig();
  if (!cfg) {
    return { ok: false, configured: false, message: "Conexión Odoo no configurada. Configura URL, BD, usuario y API Key en la pestaña Odoo." };
  }
  const sucursales = await readCol("abastecimientoSucursales").catch(() => []);
  if (!sucursales.length) {
    return { ok: false, message: "No hay sucursales configuradas. Crea sucursales primero en la pestaña Sucursales." };
  }
  const skuParams = await readCol("abastecimientoSkuParams").catch(() => []);

  const odoo = await odooConnect(cfg);

  // 1) Cargar warehouses (id, name, code, lot_stock_id)
  const warehouses = await odoo.execute_kw("stock.warehouse", "search_read",
    [[], ["id", "name", "code", "lot_stock_id"]]);

  // Map sucursal -> warehouse (por nombre del almacén, case-insensitive)
  const sucursalWh = [];
  for (const s of sucursales) {
    if (!s.almacenOdoo) continue;
    const target = String(s.almacenOdoo).trim().toLowerCase();
    const wh = warehouses.find(w =>
      String(w.name || "").trim().toLowerCase() === target ||
      String(w.code || "").trim().toLowerCase() === target
    );
    if (wh) sucursalWh.push({ sucursal: s, warehouse: wh });
  }

  if (!sucursalWh.length) {
    const cfgNames = sucursales.map(s => s.almacenOdoo || s.nombre).filter(Boolean);
    return {
      ok: false,
      reason: "no_match",
      message: `Ninguna sucursal coincide con un almacén de Odoo. Revisa el campo "Almacén Odoo" en cada sucursal (debe coincidir exactamente con el nombre o código de un almacén en Odoo).`,
      sucursalesConfiguradas: cfgNames,
      warehousesEnOdoo: warehouses.map(w => ({ id: w.id, name: w.name, code: w.code })),
      warehousesCount: warehouses.length,
    };
  }

  // 2) Cargar productos almacenables (id, default_code/sku, name)
  // Limitar a 5000 productos por seguridad
  const productosOdoo = await odoo.execute_kw("product.product", "search_read",
    [[["type", "=", "product"]], ["id", "default_code", "name", "barcode", "uom_id"]],
    { limit: 5000 });

  // Guardar productos en abastecimientoOdooProducts para que el usuario los vea en catálogo
  const productosNormalizados = productosOdoo.map(p => ({
    id: p.id,
    sku: p.default_code || "",
    nombre: p.name || "",
    barcode: p.barcode || "",
    uom: Array.isArray(p.uom_id) ? p.uom_id[1] : "",
  }));
  await writeCol("abastecimientoOdooProducts", productosNormalizados);

  // 3) Por cada sucursal+warehouse, leer stock.quant agrupado por producto
  const stockRows = [];
  for (const { sucursal, warehouse } of sucursalWh) {
    // search_read en stock.quant: domain location_id child_of warehouse.lot_stock_id
    const quants = await odoo.execute_kw("stock.quant", "search_read",
      [[["location_id", "child_of", warehouse.lot_stock_id[0]], ["product_id.type", "=", "product"]],
       ["product_id", "quantity", "reserved_quantity"]],
      { limit: 10000 });

    // Agregar quants por producto (puede haber varios por ubicación)
    const byProduct = {};
    for (const q of quants) {
      const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
      if (!byProduct[pid]) byProduct[pid] = { qty: 0, reservada: 0 };
      byProduct[pid].qty += Number(q.quantity || 0);
      byProduct[pid].reservada += Number(q.reserved_quantity || 0);
    }

    for (const pid of Object.keys(byProduct)) {
      const prod = productosOdoo.find(p => p.id === Number(pid));
      stockRows.push({
        sucursalId: sucursal.id,
        sucursalNombre: sucursal.nombre,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        productId: Number(pid),
        sku: prod?.default_code || "",
        nombre: prod?.name || "",
        qty: byProduct[pid].qty,
        reservada: byProduct[pid].reservada,
        disponible: byProduct[pid].qty - byProduct[pid].reservada,
      });
    }
  }

  await writeCol("abastecimientoOdooStock", stockRows);

  // 4) Calcular venta diaria histórica desde sale.order.line (últimos 90 días hábiles)
  //    Estructura: ventaDiariaBySku[sucursalId][sku_lower] = { totalQty, ventaDiaria }
  const VENTANA_DIAS = 90;
  const fechaCorte = new Date(Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10) + " 00:00:00";

  // Contar días hábiles (lun-vie) en la ventana
  const diasHabiles = (() => {
    const ahora = new Date();
    const inicio = new Date(Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000);
    let cnt = 0;
    for (let d = new Date(inicio); d <= ahora; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) cnt++;
    }
    return Math.max(1, cnt);
  })();

  const ventaDiariaBySku = {}; // { sucursalId: { sku_lower: ventaDiaria } }
  const ventaStats = { sucursalesProcessed: 0, lineasLeidas: 0, productosConVenta: 0 };

  for (const { sucursal, warehouse } of sucursalWh) {
    try {
      // search_read sobre sale.order.line con domain encadenado a order_id
      // Solo órdenes confirmadas (sale, done) en la ventana de tiempo y en este warehouse
      const lines = await odoo.execute_kw("sale.order.line", "search_read",
        [[
          ["order_id.state", "in", ["sale", "done"]],
          ["order_id.date_order", ">=", fechaCorte],
          ["order_id.warehouse_id", "=", warehouse.id],
          ["product_id.type", "=", "product"],
          ["qty_delivered", ">", 0],
        ], ["product_id", "qty_delivered", "product_uom_qty"]],
        { limit: 50000 });

      ventaStats.lineasLeidas += lines.length;
      const sumBySku = {}; // sku_lower -> qty acumulada

      for (const ln of lines) {
        const pid = Array.isArray(ln.product_id) ? ln.product_id[0] : ln.product_id;
        const prod = productosOdoo.find(p => p.id === pid);
        if (!prod || !prod.default_code) continue;
        const sku = String(prod.default_code).trim().toLowerCase();
        // Preferir qty_delivered (entregado) sobre product_uom_qty (vendido pero no entregado)
        const qty = Number(ln.qty_delivered || 0);
        if (qty > 0) {
          sumBySku[sku] = (sumBySku[sku] || 0) + qty;
        }
      }

      const vdMap = {};
      for (const sku of Object.keys(sumBySku)) {
        vdMap[sku] = sumBySku[sku] / diasHabiles;
      }
      ventaDiariaBySku[sucursal.id] = vdMap;
      ventaStats.productosConVenta += Object.keys(vdMap).length;
      ventaStats.sucursalesProcessed++;
    } catch (e) {
      console.error(`[odoo-sync] error venta histórica sucursal ${sucursal.nombre}:`, e?.message || e);
      ventaDiariaBySku[sucursal.id] = {};
    }
  }

  // 5) Actualizar skuParams: stockActual + ventaDiaria (sobrescribe el valor manual)
  //    Además upsert nuevas filas (sucursal×sku) para que el frontend muestre venta histórica
  //    en SKUs que no tenían override.
  const ahoraISO = new Date().toISOString();
  const paramByKey = {}; // sku_lower|sucursalId -> param existente
  for (const p of skuParams) {
    const k = `${String(p.sku || "").trim().toLowerCase()}|${p.sucursalId}`;
    paramByKey[k] = p;
  }

  let actualizadosStock = 0;
  let actualizadosVenta = 0;
  let creadosNuevos = 0;

  // 5a) Recorrer todos los stockRows: garantiza fila por SKU×sucursal y órdenes con venta histórica
  for (const row of stockRows) {
    const skuKey = String(row.sku || "").trim().toLowerCase();
    if (!skuKey) continue;
    const lookupKey = `${skuKey}|${row.sucursalId}`;
    const ventaHist = (ventaDiariaBySku[row.sucursalId] || {})[skuKey] ?? 0;
    const existing = paramByKey[lookupKey];

    if (existing) {
      const oldStock = existing.stockActual;
      const oldVenta = existing.ventaDiaria;
      const newVenta = Number(ventaHist.toFixed(3));
      const updated = {
        ...existing,
        productoId: existing.productoId || row.productId,
        nombre: existing.nombre || row.nombre,
        stockActual: row.disponible,
        ventaDiaria: newVenta,
        ventaDiariaSource: "odoo_historico",
        ventaDiariaWindow: VENTANA_DIAS,
        ventaDiariaUpdatedAt: ahoraISO,
        stockOdooSync: ahoraISO,
      };
      paramByKey[lookupKey] = updated;
      if (oldStock !== row.disponible) actualizadosStock++;
      if (Math.abs((oldVenta || 0) - newVenta) > 0.0005) actualizadosVenta++;
    } else if (ventaHist > 0) {
      // Solo creamos override automático si hay venta histórica (ahorra basura)
      const newParam = {
        id: `odoo-${row.productId}-${row.sucursalId}`,
        sucursalId: row.sucursalId,
        productoId: row.productId,
        sku: row.sku,
        nombre: row.nombre,
        stockActual: row.disponible,
        ventaDiaria: Number(ventaHist.toFixed(3)),
        ventaDiariaSource: "odoo_historico",
        ventaDiariaWindow: VENTANA_DIAS,
        ventaDiariaUpdatedAt: ahoraISO,
        leadTime: 30,
        maxDias: 60,
        margen: 0.20,
        stockOdooSync: ahoraISO,
      };
      paramByKey[lookupKey] = newParam;
      creadosNuevos++;
      actualizadosVenta++;
    }
  }

  const newParams = Object.values(paramByKey);
  await writeCol("abastecimientoSkuParams", newParams);

  // Guardar timestamp de última sync en config
  const cfgArrNow = await readCol("abastecimientoOdooConfig").catch(() => []);
  const cfgUpd = (cfgArrNow && cfgArrNow[0]) ? { ...cfgArrNow[0], lastSync: ahoraISO } : cfgArrNow[0];
  if (cfgUpd) await writeCol("abastecimientoOdooConfig", [cfgUpd]);

  return {
    ok: true,
    configured: true,
    message: `Sincronización exitosa. ${sucursalWh.length} sucursales, ${productosOdoo.length} productos, ${stockRows.length} stock, venta histórica ${VENTANA_DIAS}d (${diasHabiles} días hábiles): ${ventaStats.lineasLeidas} líneas, ${creadosNuevos} SKUs nuevos, ${actualizadosVenta} ventas/día actualizadas.`,
    stats: {
      sucursalesMapeadas: sucursalWh.length,
      productosCatalogo: productosOdoo.length,
      filasStock: stockRows.length,
      skuParamsActualizados: actualizadosStock,
      ventaHistorica: {
        ventanaDias: VENTANA_DIAS,
        diasHabiles,
        lineasLeidas: ventaStats.lineasLeidas,
        productosConVenta: ventaStats.productosConVenta,
        sucursalesProcessed: ventaStats.sucursalesProcessed,
        ventasActualizadas: actualizadosVenta,
        creadosNuevos,
      }
    }
  };
}

// Endpoint cron-trigger usado por el job diario
app.post("/api/abastecimiento/odoo-sync-cron", wrap(async (_req, res) => {
  try {
    const result = await runOdooSync();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}));

// Endpoint manual: recalcular venta diaria histórica desde Odoo (alias de sync completo)
app.post("/api/abastecimiento/odoo-recalc-venta-diaria", wrap(async (_req, res) => {
  try {
    const result = await runOdooSync();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}));

// ───── Min/Max desde Odoo (stock.move últimos 12 meses) ─────
// Metodología (del Excel Min-Max-Copikon-2026-06-23):
//   consumoDiario = consumo12m / 365
//   minimo  = consumoDiario × leadTime × (1 + margen)         (default leadTime=30, margen=0.20)
//   maximo  = minimo + consumoDiario × maxDias                 (default maxDias=60)
// Fuente consumo: stock.move con state=done, location_dest_id en location_customer (clientes)
//   o location_id es ubicación interna del almacén destino (consumo producción).
// Excluye: devoluciones a proveedor, ajustes de inventario, transferencias internas.
async function calculateMinMaxFromOdoo({ leadTime = 30, margen = 0.20, maxDias = 60, ventanaDias = 365 } = {}) {
  const cfg = await readOdooConfig();
  if (!cfg) {
    return { ok: false, configured: false, message: "Conexión Odoo no configurada." };
  }
  const sucursales = await readCol("abastecimientoSucursales").catch(() => []);
  if (!sucursales.length) {
    return { ok: false, message: "No hay sucursales configuradas." };
  }

  const odoo = await odooConnect(cfg);

  // 1) Cargar warehouses y mapear sucursales
  const warehouses = await odoo.execute_kw("stock.warehouse", "search_read",
    [[], ["id", "name", "code", "lot_stock_id"]]);
  const sucursalWh = [];
  for (const s of sucursales) {
    if (!s.almacenOdoo) continue;
    const target = String(s.almacenOdoo).trim().toLowerCase();
    const wh = warehouses.find(w =>
      String(w.name || "").trim().toLowerCase() === target ||
      String(w.code || "").trim().toLowerCase() === target
    );
    if (wh) sucursalWh.push({ sucursal: s, warehouse: wh });
  }
  if (!sucursalWh.length) {
    return { ok: false, reason: "no_match", message: "Ninguna sucursal coincide con un almacén Odoo." };
  }

  // 2) Cargar productos almacenables
  const productosOdoo = await odoo.execute_kw("product.product", "search_read",
    [[["type", "=", "product"]], ["id", "default_code", "name", "uom_id", "product_tmpl_id"]],
    { limit: 10000 });
  const productById = new Map(productosOdoo.map(p => [p.id, p]));

  // 2b) Cargar marca por product.template (campo personalizado x_brand o categ_id como fallback)
  const tmplIds = [...new Set(productosOdoo.map(p => Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : null).filter(Boolean))];
  const tmplBrand = new Map();
  if (tmplIds.length) {
    try {
      const tmpls = await odoo.execute_kw("product.template", "read",
        [tmplIds, ["id", "categ_id"]]);
      for (const t of tmpls) {
        tmplBrand.set(t.id, Array.isArray(t.categ_id) ? t.categ_id[1] : "");
      }
    } catch (_) { /* opcional */ }
  }

  // 3) Fecha de corte
  const fechaCorte = new Date(Date.now() - ventanaDias * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10) + " 00:00:00";
  const hoyISO = new Date().toISOString().slice(0, 10);

  // 4) Por sucursal, leer stock.move done con destino location_customer
  //    (Odoo modelo location: usage='customer' = ventas a cliente)
  const minmaxRows = [];
  const stats = { sucursalesProcessed: 0, movimientosLeidos: 0, productosConConsumo: 0 };

  for (const { sucursal, warehouse } of sucursalWh) {
    try {
      // Filtrar movimientos donde:
      //  - state = done
      //  - date >= fechaCorte
      //  - location_id child_of warehouse.lot_stock_id (sale DEL almacén)
      //  - location_dest_id.usage = customer (entrega al cliente, no transferencia interna)
      const moves = await odoo.execute_kw("stock.move", "search_read",
        [[
          ["state", "=", "done"],
          ["date", ">=", fechaCorte],
          ["location_id", "child_of", warehouse.lot_stock_id[0]],
          ["location_dest_id.usage", "=", "customer"],
          ["product_id.type", "=", "product"],
        ], ["product_id", "product_uom_qty", "quantity_done", "date"]],
        { limit: 100000 });

      stats.movimientosLeidos += moves.length;
      const consumoBySku = new Map(); // sku → { qty, productId, nombre, uom, marca }

      for (const m of moves) {
        const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
        const prod = productById.get(pid);
        if (!prod || !prod.default_code) continue;
        const sku = String(prod.default_code).trim();
        const qty = Number(m.quantity_done || m.product_uom_qty || 0);
        if (qty <= 0) continue;
        const cur = consumoBySku.get(sku);
        if (cur) {
          cur.qty += qty;
        } else {
          const tmplId = Array.isArray(prod.product_tmpl_id) ? prod.product_tmpl_id[0] : null;
          consumoBySku.set(sku, {
            qty,
            productId: pid,
            nombre: prod.name || "",
            uom: Array.isArray(prod.uom_id) ? prod.uom_id[1] : "Unidades",
            marca: tmplBrand.get(tmplId) || "",
          });
        }
      }

      // Generar filas Min/Max para todos los SKUs con consumo > 0
      for (const [sku, data] of consumoBySku.entries()) {
        const consumoDiario = data.qty / ventanaDias;
        const minimo = consumoDiario * leadTime * (1 + margen);
        const maximo = minimo + consumoDiario * maxDias;
        const skuClean = sku.replace(/[^A-Za-z0-9\-_.]/g, "_");
        minmaxRows.push({
          id: `mm_${sucursal.codigo}_${skuClean}`,
          sucursalId: sucursal.id,
          sucursalCodigo: sucursal.codigo,
          sku,
          producto: data.nombre,
          marca: data.marca,
          udm: data.uom,
          consumo12m: Number(data.qty.toFixed(2)),
          consumoDiario: Number(consumoDiario.toFixed(4)),
          minimo: Number(minimo.toFixed(2)),
          maximo: Number(maximo.toFixed(2)),
          fuente: "odoo_calculado",
          fechaCorte: hoyISO,
          parametros: { leadTime, margen, maxDias, ventanaDias },
        });
      }

      stats.productosConConsumo += consumoBySku.size;
      stats.sucursalesProcessed++;
    } catch (e) {
      console.error(`[minmax] error sucursal ${sucursal.nombre}:`, e?.message || e);
    }
  }

  // 5) UPSERT: preservar base Excel para SKUs sin movimiento en Odoo
  //    Estrategia: leer dataset existente, sobrescribir solo SKUs que Odoo recalculó,
  //    mantener los demás (excel_inicial) intactos para no perder stock/estado base.
  //    Para filas actualizadas desde Odoo, preservar stockActualExcel/estadoExcel del Excel original.
  const existing = await readCol("abastecimientoMinMax").catch(() => []);
  const existingByKey = new Map(existing.map(r => [`${r.sucursalCodigo}__${r.sku}`, r]));
  const odooKeys = new Set(minmaxRows.map(r => `${r.sucursalCodigo}__${r.sku}`));
  const preserved = existing.filter(r => !odooKeys.has(`${r.sucursalCodigo}__${r.sku}`));

  // Enriquecer filas Odoo con campos base del Excel (si existían)
  const enriched = minmaxRows.map(row => {
    const prev = existingByKey.get(`${row.sucursalCodigo}__${row.sku}`);
    if (prev) {
      return {
        ...row,
        stockActualExcel: prev.stockActualExcel ?? row.stockActualExcel,
        estadoExcel: prev.estadoExcel ?? row.estadoExcel,
      };
    }
    return row;
  });

  const merged = [...preserved, ...enriched];

  await writeCol("abastecimientoMinMax", merged);

  return {
    ok: true,
    configured: true,
    message: `Min/Max recalculados desde Odoo: ${minmaxRows.length} actualizadas + ${preserved.length} preservadas del Excel = ${merged.length} total.`,
    stats: {
      ...stats,
      filasOdooActualizadas: minmaxRows.length,
      filasExcelPreservadas: preserved.length,
      filasGeneradas: merged.length,
      parametros: { leadTime, margen, maxDias, ventanaDias },
      fechaCorte: hoyISO,
    }
  };
}

// Endpoint manual: recalcular Min/Max desde Odoo (acepta parámetros opcionales)
app.post("/api/abastecimiento/recalcular-minmax", wrap(async (req, res) => {
  try {
    const params = req.body || {};
    const result = await calculateMinMaxFromOdoo({
      leadTime: Number(params.leadTime) || 30,
      margen: Number(params.margen) || 0.20,
      maxDias: Number(params.maxDias) || 60,
      ventanaDias: Number(params.ventanaDias) || 365,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}));

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
