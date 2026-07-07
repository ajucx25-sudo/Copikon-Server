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
import * as odoo from "./odoo-client.js";
import XLSX from "xlsx";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);

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
  "/api/erp/infra-components": "infraComponents",
  "/api/erp/infra-component-movements": "infraComponentMovements",
  // Requerimientos especiales (Operaciones) - solicitudes ad-hoc entre unidades
  "/api/erp/special-requirements": "specialRequirements",
  // Pre-Leads (carga masiva antes de convertir a lead)
  "/api/erp/pre-leads": "preLeads",
  // Notificaciones in-app y reportes semanales de bitácora
  "/api/notifications": "notifications",
  "/api/bitacora-reports": "bitacoraReports",
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

// ───── Banda "Comisión Generators" (singleton) ──────────────────────
// Tabla Única de tramos que aplica ADITIVAMENTE a los gerentes de otras
// unidades (Tiendas, USA, Distribución, etc.) sobre ventas de Copikon Generators.
// Se guarda como singleton bajo la clave 'salary:generators-band'.
//
// Estructura:
//   { tramos: [{ minVenta, maxVenta, porcentaje }, ...],
//     notas: string,
//     updatedAt: ISO }
const DEFAULT_GENERATORS_BAND = {
  tramos: [],
  notas: "",
};

app.get("/api/salary/generators-band", wrap(async (_req, res) => {
  const b = await readSingleton("salary:generators-band");
  res.json(b && typeof b === "object" && !Array.isArray(b) ? b : DEFAULT_GENERATORS_BAND);
}));

app.put("/api/salary/generators-band", wrap(async (req, res) => {
  const body = req.body || {};
  const tramos = Array.isArray(body.tramos) ? body.tramos : [];
  // Sanitizar tramos
  const cleanTramos = tramos.map((t) => ({
    minVenta: Number(t.minVenta) || 0,
    maxVenta: t.maxVenta === null || t.maxVenta === undefined || t.maxVenta === "" ? null : Number(t.maxVenta),
    porcentaje: Number(t.porcentaje) || 0,
  }));
  const merged = {
    tramos: cleanTramos,
    notas: typeof body.notas === "string" ? body.notas : "",
    updatedAt: new Date().toISOString(),
  };
  await writeSingleton("salary:generators-band", merged);
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

// ───── Sincronización catálogo Odoo → erpProducts ────────────
// Trae productos vendibles (sale_ok=True) de Odoo y los mergea con
// los productos manuales del catálogo Copikon (por SKU/odooId).
// El endpoint puede llamarse manualmente (para forzar refresh) o desde
// el cron nocturno.

function toStrOrEmpty(v) {
  if (v == null || v === false) return "";
  return String(v).trim();
}

function odooBinaryToDataUrl(b64) {
  if (!b64 || typeof b64 !== "string") return "";
  // Odoo devuelve la imagen como base64 sin prefijo
  return `data:image/jpeg;base64,${b64}`;
}

// Mapea un product.product de Odoo al shape de erpProducts en Copikon
function mapOdooProduct(op, existingByOdooId = new Map(), existingBySku = new Map()) {
  const sku = toStrOrEmpty(op.default_code) || toStrOrEmpty(op.barcode);
  const existing =
    (op.id && existingByOdooId.get(op.id)) ||
    (sku && existingBySku.get(sku.toUpperCase())) ||
    null;

  // Categoría de Odoo (categ_id es many2one → [id, display_name])
  const odooCateg = Array.isArray(op.categ_id) ? op.categ_id[1] : "";
  // UoM (uom_id many2one → [id, name])
  const uomName = Array.isArray(op.uom_id) ? String(op.uom_id[1] || "und").toLowerCase() : "und";

  const base = existing ? { ...existing } : {
    id: null, // se asigna abajo
    stock: 0,
    stockCommitted: 0,
    minStock: 0,
    status: "activo",
    location: "",
    warehouse: "",
    syncStatus: "odoo",
    documents: null,
    galleryImages: null,
    maintenanceSchedule: null,
    serialNumber: null,
  };

  // Sobrescribir con datos de Odoo (Odoo es la fuente de verdad para SKU/nombre/precio)
  base.odooId = op.id;
  base.odooSku = sku;
  base.sku = sku || base.sku || "";
  base.code = sku || base.code || "";
  base.name = toStrOrEmpty(op.name) || base.name || "";
  base.unit = uomName || base.unit || "und";
  base.category = odooCateg ? odooCateg.toLowerCase().replace(/[\s\/]+/g, "_").slice(0, 60) : (base.category || "otros");
  base.brand = base.brand || ""; // Odoo estándar no tiene brand; se conserva el manual
  base.barcode = toStrOrEmpty(op.barcode) || base.barcode || "";
  base.salePrice = op.list_price != null ? String(op.list_price) : (base.salePrice || "");
  base.costPrice = op.standard_price != null ? String(op.standard_price) : (base.costPrice || "");
  base.stock = typeof op.qty_available === "number" ? op.qty_available : (base.stock || 0);
  base.status = op.active ? "activo" : "archivado";
  base.syncStatus = "odoo";
  base.lastSyncAt = new Date().toISOString();

  // Imagen: si viene inline la usa; sino apunta al endpoint on-demand.
  // El endpoint sirve la imagen de Odoo solo cuando el picker la pide (lazy).
  if (op.image_128) {
    base.imageUrl = odooBinaryToDataUrl(op.image_128);
  } else if (op.id) {
    base.imageUrl = `/api/erp/products/odoo-image/${op.id}`;
  } else if (!base.imageUrl) {
    base.imageUrl = "";
  }

  // Descripción corta
  const desc = toStrOrEmpty(op.description_sale) || toStrOrEmpty(op.description);
  if (desc) base.description = desc;

  return base;
}

async function syncOdooCatalog({ limit = 25000, includeImages = false } = {}) {
  if (!odoo.isConfigured()) {
    throw new Error("Odoo no configurado en el servidor");
  }

  // 1. Traer variantes vendibles activas de Odoo
  //    Campos mínimos + imagen 128px para picker (baja resolución = pesa poco)
  const fields = [
    "id", "default_code", "barcode", "name", "active",
    "list_price", "standard_price", "qty_available",
    "uom_id", "categ_id",
    "product_tmpl_id",
    "description_sale", "description",
  ];
  if (includeImages) fields.push("image_128");

  const domain = [
    ["sale_ok", "=", true],
    ["active", "=", true],
  ];

  // Odoo aplica límite server-side de 10.000 en search_read; paginamos manualmente
  const pageSize = 2000;
  const odooRows = [];
  let offset = 0;
  while (odooRows.length < limit) {
    const remaining = Math.min(pageSize, limit - odooRows.length);
    const page = await odoo.searchRead(
      "product.product",
      domain,
      fields,
      { order: "id asc", limit: remaining, offset }
    );
    odooRows.push(...page);
    if (page.length < remaining) break; // última página
    offset += page.length;
  }

  // 2. Cargar productos manuales existentes
  const manual = await readCol("erpProducts");
  const existingByOdooId = new Map();
  const existingBySku = new Map();
  let maxId = 0;
  for (const p of manual) {
    if (p.odooId) existingByOdooId.set(p.odooId, p);
    if (p.sku) existingBySku.set(String(p.sku).trim().toUpperCase(), p);
    if (Number(p.id) > maxId) maxId = Number(p.id);
  }

  // 3. Mapear y mergear
  const merged = new Map(); // key = id de Copikon
  // Primero conservar productos MANUALES no vinculados a Odoo (syncStatus !== 'odoo' o sin odooId)
  for (const p of manual) {
    if (!p.odooId && p.syncStatus !== "odoo") {
      merged.set(p.id, p);
    }
  }

  // Luego procesar los de Odoo (crear o actualizar)
  let created = 0;
  let updated = 0;
  for (const op of odooRows) {
    const mapped = mapOdooProduct(op, existingByOdooId, existingBySku);
    if (!mapped.id) {
      maxId += 1;
      mapped.id = maxId;
      created += 1;
    } else {
      updated += 1;
    }
    merged.set(mapped.id, mapped);
  }

  const finalArr = Array.from(merged.values()).sort((a, b) => Number(a.id) - Number(b.id));

  // 4. Guardar en kv.erpProducts
  await writeCol("erpProducts", finalArr);

  // 5. Registrar la sincronización
  const meta = {
    lastSyncAt: new Date().toISOString(),
    odooCount: odooRows.length,
    total: finalArr.length,
    created,
    updated,
    manualPreserved: finalArr.length - created - updated,
  };
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    ["erpProductsOdooSyncMeta", JSON.stringify(meta), Date.now()]
  );

  return meta;
}

// POST /api/erp/products/sync-odoo — dispara sincronización manual
app.post("/api/erp/products/sync-odoo", wrap(async (req, res) => {
  if (!odoo.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Odoo no configurado" });
  }
  // Tope 30k para seguridad; el catálogo real tiene ~19.622
  const limit = Math.min(Number(req.body?.limit) || 25000, 30000);
  const includeImages = req.body?.includeImages !== false;
  try {
    const meta = await syncOdooCatalog({ limit, includeImages });
    res.json({ ok: true, ...meta });
  } catch (e) {
    console.error("[odoo-sync]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}));

// POST /api/erp/products/sync-odoo/preview — solo cuenta cuántos productos vendrían (sin escribir)
app.post("/api/erp/products/sync-odoo/preview", wrap(async (_req, res) => {
  if (!odoo.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Odoo no configurado" });
  }
  try {
    const total = await odoo.count("product.product", [
      ["sale_ok", "=", true],
      ["active", "=", true],
    ]);
    res.json({ ok: true, wouldSync: total });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}));

// GET /api/erp/products/odoo-sync-status — devuelve la última sincronización
app.get("/api/erp/products/odoo-sync-status", wrap(async (_req, res) => {
  const r = await pool.query("SELECT value FROM kv WHERE key = 'erpProductsOdooSyncMeta'");
  const meta = r.rows[0]?.value || null;
  res.json({ configured: odoo.isConfigured(), meta });
}));

// ============================================================
// STOCK POR BODEGA / SUCURSAL — Requerimientos especiales v2
// Filtrado a compañía Copikon Venezuela, C.A. (J-29465456-8)
// Rutas fuera de /api/erp/products/* para no chocar con CRUD /:id.
// ============================================================

// Copikon Venezuela, C.A. — RIF J-29465456-8. Se prueba en múltiples formatos.
const COPIKON_RIF_FORMATS = ["J294654568", "J-29465456-8", "J29465456-8", "J-294654568"];
// Nombres válidos (case-insensitive). El primero que aparezca en res.company gana.
const COPIKON_NAME_INCLUDES = ["COPIKON VENEZUELA", "COPIKON C.A", "COPIKON CA", "COPIKON, C.A"];
// Nombres a EXCLUIR aunque contengan "COPIKON" (otras compañías del grupo)
const COPIKON_NAME_EXCLUDES = ["LOGAN", "JJEL", "MANGO", "2BC", "CJR", "COPIKON JR", "GENERATOR", "CELLTEK"];

// Cache del companyId de Copikon C.A. (evita lookups repetidos)
let _copikonCompanyId = null;
async function getCopikonCompanyId() {
  if (_copikonCompanyId) return _copikonCompanyId;
  const debug = { tried: [] };

  // Estrategia 1: buscar por VAT en varios formatos
  for (const rif of COPIKON_RIF_FORMATS) {
    const partners = await odoo.searchRead(
      "res.partner", [["vat", "=", rif]],
      ["id", "name", "vat"], { limit: 5 }
    );
    debug.tried.push({ strategy: "partner.vat=" + rif, hits: partners.length });
    if (partners.length) {
      const partnerIds = partners.map(p => p.id);
      const companies = await odoo.searchRead(
        "res.company", [["partner_id", "in", partnerIds]],
        ["id", "name"], { limit: 5 }
      );
      if (companies.length) {
        _copikonCompanyId = companies[0].id;
        console.log("[getCopikonCompanyId] hit via VAT", rif, "→", companies[0]);
        return _copikonCompanyId;
      }
    }
  }

  // Estrategia 2: listar TODAS las compañías, filtrar por nombre válido / excluir otras
  const allCompanies = await odoo.searchRead(
    "res.company", [], ["id", "name", "vat", "partner_id"], { limit: 100, order: "id asc" }
  );
  debug.tried.push({ strategy: "res.company all", hits: allCompanies.length });

  // Buscar por nombre exacto en el orden de includes
  for (const needle of COPIKON_NAME_INCLUDES) {
    const found = allCompanies.find(c => {
      const n = (c.name || "").toUpperCase();
      if (!n.includes(needle.toUpperCase())) return false;
      // no debe caer en excludes
      return !COPIKON_NAME_EXCLUDES.some(x => n.includes(x.toUpperCase()));
    });
    if (found) {
      _copikonCompanyId = found.id;
      console.log("[getCopikonCompanyId] hit via name", needle, "→", found);
      return _copikonCompanyId;
    }
  }

  // Estrategia 3: cualquier compañía que contenga COPIKON pero no esté en excludes
  const fallback = allCompanies.find(c => {
    const n = (c.name || "").toUpperCase();
    return n.includes("COPIKON") && !COPIKON_NAME_EXCLUDES.some(x => n.includes(x.toUpperCase()));
  });
  if (fallback) {
    _copikonCompanyId = fallback.id;
    console.log("[getCopikonCompanyId] hit via fallback COPIKON", fallback);
    return _copikonCompanyId;
  }

  console.warn("[getCopikonCompanyId] NO MATCH. Companies=", allCompanies.map(c => `${c.id}:${c.name}`).join(" | "));
  return null;
}

// GET /api/erp/companies-debug — lista todas las compañías del ERP (diagnóstico)
app.get("/api/erp/companies-debug", wrap(async (_req, res) => {
  if (!odoo.isConfigured()) return res.status(503).json({ ok: false, error: "Odoo no configurado" });
  try {
    const companies = await odoo.searchRead(
      "res.company", [], ["id", "name", "vat", "partner_id", "currency_id", "parent_id"],
      { limit: 100, order: "id asc" }
    );
    // Además intenta resolver el partner de cada compañía para ver el VAT real del partner
    const partnerIds = companies.map(c => Array.isArray(c.partner_id) ? c.partner_id[0] : null).filter(Boolean);
    const partners = partnerIds.length ? await odoo.searchRead(
      "res.partner", [["id", "in", partnerIds]],
      ["id", "name", "vat"], { limit: 100 }
    ) : [];
    const partnerMap = Object.fromEntries(partners.map(p => [p.id, p]));
    const enriched = companies.map(c => ({
      id: c.id,
      name: c.name,
      company_vat: c.vat || null,
      partner_id: Array.isArray(c.partner_id) ? c.partner_id[0] : c.partner_id,
      partner_vat: (partnerMap[Array.isArray(c.partner_id) ? c.partner_id[0] : c.partner_id] || {}).vat || null,
      parent_id: c.parent_id || null,
    }));
    const detected = await getCopikonCompanyId();
    res.json({ ok: true, count: companies.length, detectedCopikonId: detected, companies: enriched });
  } catch (e) {
    console.error("[companies-debug]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}));

// GET /api/erp/warehouses — lista bodegas activas de Copikon C.A. desde Odoo
app.get("/api/erp/warehouses", wrap(async (_req, res) => {
  if (!odoo.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Odoo no configurado" });
  }
  try {
    const companyId = await getCopikonCompanyId();
    const domain = [["active", "=", true]];
    if (companyId) domain.push(["company_id", "=", companyId]);
    const warehouses = await odoo.searchRead(
      "stock.warehouse", domain,
      ["id", "name", "code", "lot_stock_id", "partner_id", "company_id"],
      { order: "sequence asc, name asc" }
    );
    res.json({ ok: true, companyId, warehouses });
  } catch (e) {
    console.error("[warehouses]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}));

// POST /api/erp/stock-by-warehouse/sync
// Recorre bodegas de Copikon C.A. + stock.quant, guarda cache en kv.stockByWarehouse.
app.post("/api/erp/stock-by-warehouse/sync", wrap(async (_req, res) => {
  if (!odoo.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Odoo no configurado" });
  }
  try {
    const t0 = Date.now();
    const companyId = await getCopikonCompanyId();
    const whDomain = [["active", "=", true]];
    if (companyId) whDomain.push(["company_id", "=", companyId]);
    const warehouses = await odoo.searchRead(
      "stock.warehouse", whDomain,
      ["id", "name", "code", "view_location_id", "company_id"],
      { order: "sequence asc, name asc" }
    );
    if (!warehouses.length) {
      return res.json({ ok: true, warehouses: 0, products: 0, note: "Sin bodegas activas para Copikon C.A." });
    }

    // Ubicaciones internas de esas bodegas
    const whIds = warehouses.map(w => w.id);
    const allInternal = await odoo.searchRead(
      "stock.location",
      [["usage", "=", "internal"], ["active", "=", true], ["warehouse_id", "in", whIds]],
      ["id", "warehouse_id"],
      { limit: 20000 }
    );
    const internalLocIds = allInternal.map(l => l.id);
    if (!internalLocIds.length) {
      return res.json({ ok: true, warehouses: warehouses.length, products: 0, note: "Sin ubicaciones internas" });
    }

    // Agrupar stock.quant por (product_id, location_id)
    // Paginado defensivo por si excede el límite de Odoo
    const quantGroups = await odoo.readGroup(
      "stock.quant",
      [["location_id", "in", internalLocIds], ["quantity", "!=", 0]],
      ["product_id", "location_id", "quantity"],
      ["product_id", "location_id"],
      { lazy: false, limit: 200000 }
    );

    // locId -> whId
    const locToWh = new Map();
    for (const loc of allInternal) {
      const whId = Array.isArray(loc.warehouse_id) ? loc.warehouse_id[0] : null;
      if (whId) locToWh.set(loc.id, whId);
    }
    const whMeta = new Map();
    for (const w of warehouses) whMeta.set(w.id, { name: w.name, code: w.code });

    // { productId: { whId: { warehouseName, warehouseCode, qty } } }
    const stockByWh = {};
    for (const g of quantGroups) {
      const pid = Array.isArray(g.product_id) ? g.product_id[0] : null;
      const lid = Array.isArray(g.location_id) ? g.location_id[0] : null;
      const qty = Number(g.quantity) || 0;
      if (!pid || !lid) continue;
      const whId = locToWh.get(lid);
      if (!whId) continue;
      if (!stockByWh[pid]) stockByWh[pid] = {};
      if (!stockByWh[pid][whId]) {
        const meta = whMeta.get(whId) || { name: "?", code: "?" };
        stockByWh[pid][whId] = { warehouseName: meta.name, warehouseCode: meta.code, qty: 0 };
      }
      stockByWh[pid][whId].qty += qty;
    }

    const payload = {
      companyId,
      warehouses: warehouses.map(w => ({ id: w.id, name: w.name, code: w.code })),
      stockByProduct: stockByWh,
      updatedAt: new Date().toISOString(),
      productCount: Object.keys(stockByWh).length,
      elapsedMs: Date.now() - t0,
    };
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      ["stockByWarehouse", JSON.stringify(payload), Date.now()]
    );
    res.json({
      ok: true,
      companyId,
      warehouses: warehouses.length,
      warehouseList: payload.warehouses,
      products: payload.productCount,
      quantRows: quantGroups.length,
      elapsedMs: payload.elapsedMs,
    });
  } catch (e) {
    console.error("[sync-stock-by-warehouse]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}));

// GET /api/erp/stock-by-warehouse — devuelve el cache
// Query params:
//   ?odooIds=1,2,3  filtra por odoo product ids
//   ?full=1         incluye stockByProduct completo (default: incluye)
app.get("/api/erp/stock-by-warehouse", wrap(async (req, res) => {
  const r = await pool.query("SELECT value, updated_at FROM kv WHERE key = 'stockByWarehouse'");
  const payload = r.rows[0]?.value || null;
  if (!payload) {
    return res.json({ ok: true, cached: false, warehouses: [], stockByProduct: {} });
  }
  const filter = String(req.query.odooIds || "").trim();
  let stockByProduct = payload.stockByProduct || {};
  if (filter) {
    const ids = new Set(filter.split(",").map(s => Number(s.trim())).filter(Boolean));
    stockByProduct = Object.fromEntries(
      Object.entries(stockByProduct).filter(([k]) => ids.has(Number(k)))
    );
  }
  res.json({
    ok: true,
    cached: true,
    updatedAt: payload.updatedAt,
    warehouses: payload.warehouses || [],
    stockByProduct,
    productCount: Object.keys(stockByProduct).length,
  });
}));

// GET /api/erp/products/odoo-image/:odooId — sirve la imagen del producto desde Odoo (on-demand)
// Cache 24h en cliente. Reduce el payload del catálogo (imagenes lazy).
const _odooImageCache = new Map(); // odooId -> { dataUrl, at }
const ODOO_IMG_TTL = 12 * 60 * 60 * 1000; // 12h
app.get("/api/erp/products/odoo-image/:odooId", wrap(async (req, res) => {
  const id = Number(req.params.odooId);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const now = Date.now();
  const cached = _odooImageCache.get(id);
  if (cached && (now - cached.at) < ODOO_IMG_TTL) {
    res.set("Cache-Control", "public, max-age=86400");
    return res.type("image/jpeg").send(cached.buffer);
  }
  try {
    const rows = await odoo.searchRead("product.product", [["id", "=", id]], ["image_128"], { limit: 1 });
    const b64 = rows[0]?.image_128;
    if (!b64) return res.status(404).end();
    const buffer = Buffer.from(b64, "base64");
    _odooImageCache.set(id, { buffer, at: now });
    // limpiar cache si crece demasiado
    if (_odooImageCache.size > 500) {
      const oldest = Array.from(_odooImageCache.entries())
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, 100);
      for (const [k] of oldest) _odooImageCache.delete(k);
    }
    res.set("Cache-Control", "public, max-age=86400");
    res.type("image/jpeg").send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
// Bitacora - Recordatorios y Reportes Semanales
// Cada área tiene su propio prefijo de módulo y su propio manager referente.
// Config unificada de bitácoras por área (Generators, Administración Corporativa, ...)
const BITACORA_AREAS = {
  generators: {
    modulePrefix: "gen-",
    label: "Copikon Generators",
    managerDeptId: 31,
    reportLinkBase: "/copikon-generators?module=bitacora",
  },
  administracion: {
    modulePrefix: "adm-",
    label: "Área Administrativa Corporativa",
    // Departamento de la Central Administrativa Corporativa (raiz del área).
    // Si no existe manager específico, notifica solo al CEO + directiva.
    managerDeptId: null,
    reportLinkBase: "/administracion?module=bitacora",
  },
};

// Backward-compat: algún codigo puede referirse al prefijo Generators por const
const BITACORA_MODULE_PREFIX = BITACORA_AREAS.generators.modulePrefix;

function caracasNow() {
  return new Date(Date.now() - 4 * 60 * 60 * 1000);
}

function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

async function getBitacoraRecipients(managerDeptId = null) {
  const employees = await readCol("employees");
  const ceo = employees.find((e) => e && (e.level === "ceo" || e.username === "admin"));
  const areaManager = managerDeptId
    ? employees.find(
        (e) => e && Number(e.departmentId) === Number(managerDeptId) && (e.level === "manager" || e.level === "gerente")
      )
    : null;
  const managers = employees.filter((e) => e && (e.level === "manager" || e.level === "ceo"));
  return { ceo, areaManager, generatorsManager: areaManager, directiva: managers };
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

// Endpoint genérico parametrizado por área: /api/bitacora/:area/check-daily
// (mantengo también /api/generators/bitacora/... por compatibilidad con crons existentes)
async function bitacoraCheckDailyHandler(areaKey, res) {
  const areaCfg = BITACORA_AREAS[areaKey];
  if (!areaCfg) return res.status(404).json({ ok: false, error: `Área desconocida: ${areaKey}` });

  const caracasToday = caracasNow();
  const yesterday = new Date(caracasToday.getTime() - 24 * 60 * 60 * 1000);
  const yDateStr = yesterday.toISOString().slice(0, 10);

  if (!isWeekday(yesterday)) {
    return res.json({ ok: true, skipped: true, reason: "yesterday-was-weekend", date: yDateStr, area: areaKey });
  }

  const activities = await readCol("copikonGenActivities");
  const yActivities = (activities || []).filter((a) => {
    if (!a || a.type !== "bitacora") return false;
    if (typeof a.module !== "string" || !a.module.startsWith(areaCfg.modulePrefix)) return false;
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
      area: areaKey,
    });
  }

  const { ceo, areaManager } = await getBitacoraRecipients(areaCfg.managerDeptId);
  const sent = [];
  const ddmm = yDateStr.split("-").reverse().slice(0, 2).join("/");
  const title = `Sin actividades en bitacora ${areaCfg.label} (${ddmm})`;
  const message = `No se registro ninguna actividad en la bitacora de ${areaCfg.label} el dia ${ddmm}. Por favor verificar con los responsables.`;
  const link = areaCfg.reportLinkBase;

  if (ceo) {
    const n = await pushNotification({ userId: ceo.id, title, message, type: "warning", link });
    sent.push({ userId: ceo.id, who: "ceo", id: n?.id });
  }
  if (areaManager && areaManager.id !== ceo?.id) {
    const n = await pushNotification({ userId: areaManager.id, title, message, type: "warning", link });
    sent.push({ userId: areaManager.id, who: `gerente-${areaKey}`, id: n?.id });
  }

  res.json({ ok: true, date: yDateStr, area: areaKey, recipients: sent });
}

app.post("/api/generators/bitacora/check-daily", wrap((_req, res) => bitacoraCheckDailyHandler("generators", res)));
app.post("/api/bitacora/:area/check-daily", wrap((req, res) => bitacoraCheckDailyHandler(req.params.area, res)));

async function bitacoraWeeklyReportHandler(areaKey, res) {
  const areaCfg = BITACORA_AREAS[areaKey];
  if (!areaCfg) return res.status(404).json({ ok: false, error: `Área desconocida: ${areaKey}` });

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
      a.module.startsWith(areaCfg.modulePrefix) &&
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
    area: areaKey,
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
  // Cada área tiene su propia serie de reportes (previa a este cambio no habia campo area,
  // por lo que los que no tienen area se tratan como generators para compatibilidad)
  const existingIdx = reports.findIndex((r) => r.weekStart === fromStr && ((r.area || "generators") === areaKey));
  if (existingIdx >= 0) {
    reports[existingIdx] = report;
  } else {
    reports.push(report);
  }
  const trimmed = reports.length > 104 ? reports.slice(-104) : reports;
  await writeCol("bitacoraReports", trimmed);

  const { ceo, areaManager, directiva } = await getBitacoraRecipients(areaCfg.managerDeptId);
  const recipients = new Map();
  if (ceo) recipients.set(ceo.id, { who: "ceo", emp: ceo });
  if (areaManager) recipients.set(areaManager.id, { who: `gerente-${areaKey}`, emp: areaManager });
  for (const m of directiva) recipients.set(m.id, { who: "directiva", emp: m });

  const fmtDdMm = (s) => s.split("-").reverse().slice(0, 2).join("/");
  const title = `Reporte semanal bitacora ${areaCfg.label} (${fmtDdMm(fromStr)} - ${fmtDdMm(toStr)})`;
  const message = `Disponible el reporte de bitacora de ${areaCfg.label} de la semana. Total: ${totalActivities} actividades, ${completadas} completadas (${report.stats.completionRate}%), ${enProgreso} en progreso, ${pendientes} pendientes.`;
  const link = `${areaCfg.reportLinkBase}&report=${report.id}`;

  const sent = [];
  for (const [userId, info] of recipients.entries()) {
    const n = await pushNotification({ userId, title, message, type: "info", link });
    sent.push({ userId, who: info.who, id: n?.id });
  }

  res.json({ ok: true, report, recipients: sent });
}

app.post("/api/generators/bitacora/generate-weekly-report", wrap((_req, res) => bitacoraWeeklyReportHandler("generators", res)));
app.post("/api/bitacora/:area/generate-weekly-report", wrap((req, res) => bitacoraWeeklyReportHandler(req.params.area, res)));

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

// ============================================================
// MÓDULO ADMINISTRACIÓN — Endpoints Odoo (P&L, Balance, AR/AP, Cashflow)
// ============================================================
// Multi-company nativo. Todos los endpoints aceptan company_id (int).
// Si company_id se omite o es 0 → CONSOLIDADO (todas las compañías).
// Fechas en formato YYYY-MM-DD. Montos en la moneda de la compañía.
// ============================================================

function parseCompanyIds(q) {
  const raw = q.company_id;
  if (!raw || raw === "0" || raw === "all" || raw === "consolidado") return null; // null = todas
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? [id] : null;
}

function todayIso() { return new Date().toISOString().slice(0, 10); }
function firstDayOfMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Contexto Odoo con allowed_company_ids para forzar multi-company
function ctxCompanies(companyIds) {
  if (!companyIds) return {}; // sin restricción = ve todas las permitidas al usuario
  return { allowed_company_ids: companyIds, force_company: companyIds[0] };
}

// GET /api/admin/finanzas/ping — test de conexión con Odoo
app.get("/api/admin/finanzas/ping", wrap(async (_req, res) => {
  if (!odoo.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Odoo no configurado (faltan env vars ODOO_URL / ODOO_DB / ODOO_LOGIN / ODOO_API_KEY)" });
  }
  const info = await odoo.ping();
  res.json(info);
}));

// GET /api/admin/finanzas/companies — lista de compañías
app.get("/api/admin/finanzas/companies", wrap(async (_req, res) => {
  const rows = await odoo.searchRead(
    "res.company",
    [],
    ["id", "name", "vat", "currency_id", "country_id"],
    { order: "name asc" }
  );
  res.json({ companies: rows });
}));

// GET /api/admin/finanzas/pnl — Estado de Resultados
// Query params: company_id, date_from, date_to
app.get("/api/admin/finanzas/pnl", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const date_from = String(req.query.date_from || firstDayOfMonthIso());
  const date_to = String(req.query.date_to || todayIso());
  const ctx = ctxCompanies(companyIds);

  // Dominio: solo asientos posted + rango de fechas + tipos Income/Expense
  // account.account.internal_group: 'income' | 'expense' | 'asset' | 'liability' | 'equity' | 'off_balance'
  const domainBase = [
    ["parent_state", "=", "posted"],
    ["date", ">=", date_from],
    ["date", "<=", date_to],
  ];
  if (companyIds) domainBase.push(["company_id", "in", companyIds]);

  // Ingresos (internal_group = 'income') → balance típicamente negativo, se muestra positivo
  const incomeDomain = [...domainBase, ["account_id.internal_group", "=", "income"]];
  const expenseDomain = [...domainBase, ["account_id.internal_group", "=", "expense"]];

  const [incomeGroups, expenseGroups] = await Promise.all([
    odoo.readGroup(
      "account.move.line",
      incomeDomain,
      ["balance:sum", "account_id"],
      ["account_id"],
      { context: ctx, lazy: false, limit: 500 }
    ),
    odoo.readGroup(
      "account.move.line",
      expenseDomain,
      ["balance:sum", "account_id"],
      ["account_id"],
      { context: ctx, lazy: false, limit: 500 }
    ),
  ]);

  // En Odoo, ingresos tienen balance negativo (credit > debit).
  // Invertimos signo para mostrar ingresos como positivos.
  const income = incomeGroups.map(g => ({
    account_id: g.account_id?.[0],
    account_name: g.account_id?.[1],
    amount: -(g.balance || 0),
    count: g.__count || 0,
  })).filter(r => Math.abs(r.amount) > 0.005);

  const expense = expenseGroups.map(g => ({
    account_id: g.account_id?.[0],
    account_name: g.account_id?.[1],
    amount: g.balance || 0,
    count: g.__count || 0,
  })).filter(r => Math.abs(r.amount) > 0.005);

  const totalIncome = income.reduce((s, r) => s + r.amount, 0);
  const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
  const netIncome = totalIncome - totalExpense;

  res.json({
    filters: { company_ids: companyIds, date_from, date_to },
    income,
    expense,
    totals: {
      income: totalIncome,
      expense: totalExpense,
      net_income: netIncome,
      margin_pct: totalIncome !== 0 ? (netIncome / totalIncome) * 100 : 0,
    },
  });
}));

// GET /api/admin/finanzas/balance — Balance General
// Query params: company_id, as_of (fecha corte, default hoy)
app.get("/api/admin/finanzas/balance", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const ctx = ctxCompanies(companyIds);

  const domainBase = [
    ["parent_state", "=", "posted"],
    ["date", "<=", as_of],
  ];
  if (companyIds) domainBase.push(["company_id", "in", companyIds]);

  // Traer agrupado por internal_group (asset/liability/equity)
  const groups = ["asset", "liability", "equity"];
  const results = await Promise.all(
    groups.map(g => odoo.readGroup(
      "account.move.line",
      [...domainBase, ["account_id.internal_group", "=", g]],
      ["balance:sum", "account_id"],
      ["account_id"],
      { context: ctx, lazy: false, limit: 500 }
    ))
  );

  // También trae la utilidad del período (income - expense acumulada hasta as_of)
  const [incomeGroups, expenseGroups] = await Promise.all([
    odoo.readGroup(
      "account.move.line",
      [...domainBase, ["account_id.internal_group", "=", "income"]],
      ["balance:sum"],
      [],
      { context: ctx, lazy: false }
    ),
    odoo.readGroup(
      "account.move.line",
      [...domainBase, ["account_id.internal_group", "=", "expense"]],
      ["balance:sum"],
      [],
      { context: ctx, lazy: false }
    ),
  ]);

  const totalIncome = -(incomeGroups[0]?.balance || 0);
  const totalExpense = expenseGroups[0]?.balance || 0;
  const retainedEarnings = totalIncome - totalExpense;

  const mapAccounts = (arr, invert = false) => arr.map(g => ({
    account_id: g.account_id?.[0],
    account_name: g.account_id?.[1],
    amount: invert ? -(g.balance || 0) : (g.balance || 0),
  })).filter(r => Math.abs(r.amount) > 0.005);

  // Activo: balance positivo (débito). Pasivo/Patrimonio: balance negativo (crédito) → invertir.
  const assets = mapAccounts(results[0], false);
  const liabilities = mapAccounts(results[1], true);
  const equity = mapAccounts(results[2], true);

  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0);

  res.json({
    filters: { company_ids: companyIds, as_of },
    assets,
    liabilities,
    equity,
    retained_earnings: retainedEarnings,
    totals: {
      assets: totalAssets,
      liabilities: totalLiabilities,
      equity: totalEquity + retainedEarnings,
      liabilities_plus_equity: totalLiabilities + totalEquity + retainedEarnings,
      balance_check: totalAssets - (totalLiabilities + totalEquity + retainedEarnings),
    },
  });
}));

// GET /api/admin/finanzas/ar-ap — Cuentas x Cobrar y x Pagar con aging
// Query params: company_id, as_of (default hoy)
//
// ENFOQUE: se recorren account.move.line NO reconciliadas en cuentas receivable
// (AR) y payable (AP). Esto refleja el BALANCE REAL FINAL por partner,
// considerando facturas abiertas MENOS pagos a cuenta / anticipos ya registrados
// aunque aún no estén conciliados con una factura específica.
//
// - move.line.balance      → débito - crédito en moneda de compañía (USD)
// - move.line.amount_residual → residual firmado, en moneda de compañía
//   AR: positivo = cliente nos debe; negativo = anticipo del cliente
//   AP: negativo = le debemos al proveedor; positivo = anticipo dado
app.get("/api/admin/finanzas/ar-ap", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const ctx = ctxCompanies(companyIds);
  const asOfDate = new Date(as_of);

  // ── SALDO CONTABLE (Balance General): sum(balance) de todas las líneas posteadas
  //     en cuentas receivable/payable hasta as_of. Esto coincide con la línea
  //     "Cuentas por Cobrar" / "Cuentas por Pagar" del Balance General de Odoo.
  const glDomainBase = [
    ["parent_state", "=", "posted"],
    ["date", "<=", as_of],
  ];
  if (companyIds) glDomainBase.push(["company_id", "in", companyIds]);

  const [arGlLines, apGlLines] = await Promise.all([
    odoo.searchRead("account.move.line",
      [...glDomainBase, ["account_id.user_type_id.type", "=", "receivable"]],
      ["balance"], { context: ctx, limit: 50000 }),
    odoo.searchRead("account.move.line",
      [...glDomainBase, ["account_id.user_type_id.type", "=", "payable"]],
      ["balance"], { context: ctx, limit: 50000 }),
  ]);
  const ar_gl_balance = arGlLines.reduce((s, l) => s + (l.balance || 0), 0);
  const ap_gl_balance = Math.abs(apGlLines.reduce((s, l) => s + (l.balance || 0), 0));

  // IMPORTANTE: usamos el MISMO filtro del reporte Aged Receivable de Odoo v15:
  //   full_reconcile_id = false  (no totalmente reconciliadas — incluye parcialmente reconciliadas)
  //   date <= as_of              (excluye facturas emitidas después del corte)
  // Antes usabamos reconciled=false, que excluía las líneas parcialmente reconciliadas
  // y por eso el KPI no cuadraba con el reporte oficial de Odoo.
  const lineDomainBase = [
    ["parent_state", "=", "posted"],
    ["full_reconcile_id", "=", false],
    ["date", "<=", as_of],
  ];
  if (companyIds) lineDomainBase.push(["company_id", "in", companyIds]);

  const lineFields = [
    "id", "move_id", "move_name", "partner_id", "account_id",
    "debit", "credit", "balance", "amount_residual", "amount_residual_currency",
    "currency_id", "company_id", "company_currency_id",
    "date", "date_maturity", "name", "ref",
  ];

  const [arLines, apLines] = await Promise.all([
    odoo.searchRead(
      "account.move.line",
      [...lineDomainBase, ["account_id.user_type_id.type", "=", "receivable"]],
      lineFields,
      { context: ctx, limit: 20000, order: "date_maturity asc" }
    ),
    odoo.searchRead(
      "account.move.line",
      [...lineDomainBase, ["account_id.user_type_id.type", "=", "payable"]],
      lineFields,
      { context: ctx, limit: 20000, order: "date_maturity asc" }
    ),
  ]);

  // Enriquecer con move_type y payment_state en un solo call
  const allMoveIds = Array.from(new Set([...arLines, ...apLines].map(l => l.move_id?.[0]).filter(Boolean)));
  const moveInfoArr = allMoveIds.length ? await odoo.searchRead(
    "account.move",
    [["id", "in", allMoveIds]],
    ["id", "move_type", "payment_state", "invoice_date", "invoice_date_due", "name", "amount_total_signed", "currency_id"],
    { context: ctx, limit: allMoveIds.length }
  ) : [];
  const moveInfo = new Map(moveInfoArr.map(m => [m.id, m]));

  function buildAging(lines, isAR) {
    // isAR=true → AR: cliente nos debe si residual > 0 (positivo); anticipo si residual < 0
    // isAR=false → AP: le debemos si residual < 0 (negativo); anticipo dado si residual > 0
    const sign = isAR ? 1 : -1; // multiplicar residual por sign → positivo = deuda del partner

    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    let advancesTotal = 0; // absoluto: monto de anticipos/pagos-a-cuenta
    let advancesCount = 0;
    const byPartner = new Map();
    const rows = [];
    const advanceRows = [];

    for (const l of lines) {
      const partnerId = l.partner_id?.[0] || 0;
      const partnerName = l.partner_id?.[1] || "(sin partner)";
      const moveId = l.move_id?.[0];
      const mi = moveInfo.get(moveId) || {};
      const moveType = mi.move_type || "entry";
      const paymentState = mi.payment_state || null;

      // Residual signed en USD (moneda de compañía)
      const residSigned = l.amount_residual || 0;
      const debtUsd = residSigned * sign; // positivo = partner debe / negativo = anticipo

      const isAdvance = debtUsd < 0; // línea contraria al signo esperado → anticipo

      if (!byPartner.has(partnerId)) {
        byPartner.set(partnerId, {
          partner_id: partnerId, partner_name: partnerName,
          total: 0, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0,
          advances: 0, count: 0, advance_count: 0,
        });
      }
      const p = byPartner.get(partnerId);

      if (isAdvance) {
        // Anticipo o pago a cuenta — reduce el neto del partner pero no va a aging
        const advAbs = Math.abs(debtUsd);
        advancesTotal += advAbs;
        advancesCount += 1;
        p.advances += advAbs;
        p.advance_count += 1;
        p.total += debtUsd; // negativo, reduce total

        advanceRows.push({
          id: l.id,
          move_id: moveId,
          move_name: l.move_name || mi.name || l.name || "(sin nombre)",
          partner_id: partnerId,
          partner_name: partnerName,
          amount: advAbs,
          date: l.date,
          move_type: moveType,
          reference: l.ref || l.name,
        });
      } else {
        // Deuda normal — aging por fecha de vencimiento
        const due = l.date_maturity ? new Date(l.date_maturity) : (l.date ? new Date(l.date) : null);
        const daysOverdue = due ? Math.floor((asOfDate - due) / (1000 * 60 * 60 * 24)) : 0;
        let bucket = "current";
        if (daysOverdue > 90) bucket = "d90plus";
        else if (daysOverdue > 60) bucket = "d61_90";
        else if (daysOverdue > 30) bucket = "d31_60";
        else if (daysOverdue > 0) bucket = "d1_30";

        buckets[bucket] += debtUsd;
        p[bucket] += debtUsd;
        p.total += debtUsd;
        p.count += 1;

        rows.push({
          id: l.id,
          move_id: moveId,
          name: l.move_name || mi.name || "(sin nombre)",
          partner_id: partnerId,
          partner_name: partnerName,
          company_id: l.company_id?.[0],
          company_name: l.company_id?.[1],
          invoice_date: mi.invoice_date || l.date,
          due_date: l.date_maturity,
          days_overdue: daysOverdue,
          bucket,
          amount_total: Math.abs(mi.amount_total_signed || 0),
          amount_residual: debtUsd,
          currency: l.company_currency_id?.[1] || "USD",
          currency_original: l.currency_id?.[1] || "USD",
          amount_residual_original: l.amount_residual_currency || null,
          move_type: moveType,
          payment_state: paymentState,
        });
      }
    }

    // === Aplicar anticipos por partner a los buckets, empezando por los más vencidos ===
    // Fase 1: cada partner aplica sus anticipos a SUS propios buckets (d90plus → current).
    // Fase 2: los sobrantes de cada partner (anticipo > su deuda) se agrupan y aplican al
    //   bucket global vencido más antiguo. Esto refleja que el saldo NETO del Balance
    //   General ya considera esos anticipos, por lo que los buckets deben sumar exactamente
    //   el saldo neto (y el % vencido no puede pasar del 100%).
    const bucketsGross = { ...buckets };
    const bucketOrder = ["d90plus", "d61_90", "d31_60", "d1_30", "current"];
    let unappliedByPartner = 0;

    // Fase 1 — aplicar anticipos dentro de cada partner
    for (const p of byPartner.values()) {
      let remaining = p.advances;
      if (remaining <= 0) continue;
      for (const b of bucketOrder) {
        if (remaining <= 0) break;
        const bucketVal = p[b];
        if (bucketVal <= 0) continue;
        const applied = Math.min(remaining, bucketVal);
        p[b] = bucketVal - applied;
        buckets[b] -= applied;
        remaining -= applied;
      }
      if (remaining > 0) {
        // Este partner tiene anticipo sobrante (nos debe menos de lo que nos pagó por adelantado)
        unappliedByPartner += remaining;
        p.advances_unapplied = remaining;
      }
    }

    // Fase 2 — aplicar sobrantes globales al bucket más vencido del total
    // Esto asegura que sum(buckets) == netTotal (saldo neto real del Balance General)
    let netAdvances = unappliedByPartner;
    let overflow = unappliedByPartner;
    for (const b of bucketOrder) {
      if (overflow <= 0) break;
      const bucketVal = buckets[b];
      if (bucketVal <= 0) continue;
      const applied = Math.min(overflow, bucketVal);
      buckets[b] = bucketVal - applied;
      overflow -= applied;
    }
    // Si aún queda overflow, significa que hay más anticipos que deuda total
    // (raro, solo si el saldo neto es realmente negativo). Se refleja como saldo a favor.
    netAdvances = overflow;

    // Ordenar y limpiar partners (algunos pueden tener total=0 si anticipos == deuda)
    const byPartnerArr = Array.from(byPartner.values())
      .filter(p => p.total !== 0 || p.advances > 0)
      .sort((a, b) => b.total - a.total);

    const grossTotal = bucketsGross.current + bucketsGross.d1_30 + bucketsGross.d31_60 + bucketsGross.d61_90 + bucketsGross.d90plus;
    const netTotal = grossTotal - advancesTotal;

    return {
      rows,
      advances: advanceRows,
      buckets,                    // NETO por bucket (anticipos ya aplicados desde d90plus hacia abajo)
      buckets_gross: bucketsGross, // Bruto por bucket (sin aplicar anticipos, para auditoría)
      total: netTotal,             // NETO tras aplicar anticipos (balance final real)
      gross_total: grossTotal,     // Bruto sin anticipos (facturas abiertas)
      advances_total: advancesTotal,
      advances_unapplied: netAdvances, // Anticipos sobrantes (mayor que deuda del partner)
      advances_count: advancesCount,
      by_partner: byPartnerArr,
    };
  }

  const arAging = buildAging(arLines, true);
  const apAging = buildAging(apLines, false);
  arAging.gl_balance = ar_gl_balance;   // saldo contable según Balance General
  apAging.gl_balance = ap_gl_balance;

  // NUEVO: traer el reporte OFICIAL de Odoo (Aged Receivable/Payable) vía get_html
  // Extrae los buckets y el total exactos que Odoo calcula
  const odooReport = { ar: null, ap: null };
  async function fetchOdooAgedReport(modelName) {
    try {
      const options = {
        date: { date_to: as_of, filter: "custom", mode: "single", string: as_of },
        all_entries: false,
        unfold_all: false,
        unposted_in_period: false,
        partner_ids: null,
        partner_categories: null,
        analytic_accounts: null,
        analytic_tags: null,
        journals: [],
        filter_account_type: modelName === "account.aged.receivable" ? "receivable" : "payable",
        multi_company: companyIds ? companyIds.map(id => ({ id })) : [],
      };
      const html = await odoo.execute(modelName, "get_html", [[], options], { context: ctx });
      const htmlStr = String(html);
      const parseAmt = s => {
        if (!s) return 0;
        const norm = String(s).replace(/\./g, '').replace(',', '.');
        return parseFloat(norm) || 0;
      };
      // Extraer todos los cells de valor
      const cellPattern = /o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g;
      const allCells = [];
      let m;
      while ((m = cellPattern.exec(htmlStr)) !== null) allCells.push(m[1]);
      if (allCells.length < 7) return { error: "HTML sin celdas suficientes", cells_count: allCells.length };
      const last7 = allCells.slice(-7);
      const [current_g, d1_30_g, d31_60_g, d61_90_g, d91_120_g, older_g, total] = last7.map(parseAmt);

      // NUEVO: extraer filas por partner del HTML para hacer buckets NETOS
      // Cada partner tiene un total y buckets brutos; agrupamos su neto en el bucket más antiguo con saldo
      const trPattern = /<tr\b[\s\S]*?<\/tr>/g;
      const allTrs = htmlStr.match(trPattern) || [];
      const partnerRows = [];
      for (const trHtml of allTrs) {
        const cellVals = [...trHtml.matchAll(/o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g)].map(x => parseAmt(x[1]));
        if (cellVals.length >= 7) {
          const textOnly = trHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
          const name = textOnly.split(/\s+Conciliar\s+/)[0].replace(/\s+/g, ' ').trim().slice(0, 100);
          // Filas relevantes: partner headers (7 buckets exactos) - excluir fila Total
          const isTotalRow = /^Total\s+Total/i.test(name);
          if (!isTotalRow && cellVals.length === 7) {
            const [c, d1, d3, d6, d9, o, t] = cellVals.slice(-7);
            partnerRows.push({ name, current: c, d1_30: d1, d31_60: d3, d61_90: d6, d91_120: d9, older: o, total: t });
          }
        }
      }

      // Deduplicar por nombre (el HTML tiene filas anidadas: header + detalle)
      const seenPartners = new Map();
      for (const p of partnerRows) {
        if (!seenPartners.has(p.name)) seenPartners.set(p.name, p);
      }

      // Buckets NETOS por partner (FIFO desde el más NUEVO):
      // Para cada partner con NETO POSITIVO (nos debe/le debemos):
      //   1) Tomar solo sus buckets con saldo positivo (deuda real)
      //   2) Aplicar sus anticipos (buckets negativos) empezando por el bucket más NUEVO
      //      Esto es la lógica contable estándar: el anticipo cubre primero la deuda más reciente
      //   3) Lo que queda son los buckets NETOS del partner (todos >= 0)
      // Para cada partner con NETO NEGATIVO (tenemos anticipo neto sobrante):
      //   → Se cuenta como 'anticipos_netos' aparte, NO se resta de ningún bucket
      const bucketsNet = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, older: 0 };
      let anticiposNetosSobrantes = 0;
      let partnersWithNetPositive = 0;
      let partnersWithNetNegative = 0;

      for (const p of seenPartners.values()) {
        const bruteBuckets = { current: p.current, d1_30: p.d1_30, d31_60: p.d31_60, d61_90: p.d61_90, d91_120: p.d91_120, older: p.older };
        const net = p.total;
        if (Math.abs(net) < 0.01) continue;

        if (net < 0) {
          // Partner con anticipo NETO sobrante: no toca ningún bucket, se contabiliza aparte
          anticiposNetosSobrantes += net; // negativo
          partnersWithNetNegative++;
          continue;
        }

        partnersWithNetPositive++;
        // Partner con NETO POSITIVO: aplicar anticipos internos desde el bucket más nuevo
        const positives = { current: Math.max(0, bruteBuckets.current), d1_30: Math.max(0, bruteBuckets.d1_30), d31_60: Math.max(0, bruteBuckets.d31_60), d61_90: Math.max(0, bruteBuckets.d61_90), d91_120: Math.max(0, bruteBuckets.d91_120), older: Math.max(0, bruteBuckets.older) };
        let negTotal = 0;
        for (const b of Object.keys(bruteBuckets)) if (bruteBuckets[b] < 0) negTotal += bruteBuckets[b];
        let remainingAdvance = -negTotal;

        const orderNewestFirst = ['current', 'd1_30', 'd31_60', 'd61_90', 'd91_120', 'older'];
        for (const b of orderNewestFirst) {
          if (remainingAdvance <= 0) break;
          const applied = Math.min(remainingAdvance, positives[b]);
          positives[b] -= applied;
          remainingAdvance -= applied;
        }
        // Ahora positives[] contiene los buckets netos del partner (todos >= 0, suman net)
        for (const b of Object.keys(positives)) bucketsNet[b] += positives[b];
      }

      return {
        buckets_gross: {
          current: current_g, d1_30: d1_30_g, d31_60: d31_60_g,
          d61_90: d61_90_g, d91_120: d91_120_g, older: older_g,
          d90plus: d91_120_g + older_g,
        },
        buckets: {
          current: bucketsNet.current,
          d1_30: bucketsNet.d1_30,
          d31_60: bucketsNet.d31_60,
          d61_90: bucketsNet.d61_90,
          d91_120: bucketsNet.d91_120,
          older: bucketsNet.older,
          d90plus: bucketsNet.d91_120 + bucketsNet.older,
        },
        total,
        partner_count: seenPartners.size,
        partners_positive: partnersWithNetPositive,
        partners_negative: partnersWithNetNegative,
        anticipos_netos_sobrantes: anticiposNetosSobrantes, // valor negativo: monto de anticipos que no compensan deuda del mismo partner
        source: "odoo_official_report_html_net_by_partner",
      };
    } catch (e) {
      return { error: String(e).slice(0, 300) };
    }
  }

  try {
    const [arRep, apRep] = await Promise.all([
      fetchOdooAgedReport("account.aged.receivable"),
      fetchOdooAgedReport("account.aged.payable"),
    ]);
    odooReport.ar = arRep;
    odooReport.ap = apRep;
  } catch (e) {
    odooReport.error = String(e).slice(0, 300);
  }

  // Si tenemos el reporte oficial, sobreescribimos el total y buckets con los de Odoo
  // para que el KPI cuadre 100% con lo que ve el usuario en Odoo.
  // gl_balance queda como el saldo contable original del Balance General (para auditoría cruzada).
  if (odooReport.ar && !odooReport.ar.error && Math.abs(odooReport.ar.total) > 0) {
    arAging.odoo_report = odooReport.ar;
    arAging.total = odooReport.ar.total;
    arAging.buckets = {
      current: odooReport.ar.buckets.current,
      d1_30: odooReport.ar.buckets.d1_30,
      d31_60: odooReport.ar.buckets.d31_60,
      d61_90: odooReport.ar.buckets.d61_90,
      d90plus: odooReport.ar.buckets.d90plus,
    };
    arAging.anticipos_netos_sobrantes = odooReport.ar.anticipos_netos_sobrantes || 0;
    // gl_balance ahora se toma del propio reporte de Odoo (que ES el saldo oficial)
    arAging.gl_balance = odooReport.ar.total;
  }
  if (odooReport.ap && !odooReport.ap.error && Math.abs(odooReport.ap.total) > 0) {
    apAging.odoo_report = odooReport.ap;
    apAging.total = odooReport.ap.total;
    apAging.buckets = {
      current: odooReport.ap.buckets.current,
      d1_30: odooReport.ap.buckets.d1_30,
      d31_60: odooReport.ap.buckets.d31_60,
      d61_90: odooReport.ap.buckets.d61_90,
      d90plus: odooReport.ap.buckets.d90plus,
    };
    apAging.anticipos_netos_sobrantes = odooReport.ap.anticipos_netos_sobrantes || 0;
    apAging.gl_balance = odooReport.ap.total;
  }

  res.json({
    filters: { company_ids: companyIds, as_of },
    ar: arAging,
    ap: apAging,
  });
}));

// GET /api/admin/finanzas/ar-ap/diag/aged-html — Devuelve el HTML crudo del reporte Aged
app.get("/api/admin/finanzas/ar-ap/diag/aged-html", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const kind = String(req.query.kind || "payable"); // 'payable' or 'receivable'
  const modelName = kind === "receivable" ? "account.aged.receivable" : "account.aged.payable";
  const ctx = ctxCompanies(companyIds);
  const options = {
    date: { date_to: as_of, filter: "custom", mode: "single", string: as_of },
    all_entries: false,
    unfold_all: true,
    unposted_in_period: false,
    partner_ids: null,
    partner_categories: null,
    analytic_accounts: null,
    analytic_tags: null,
    journals: [],
    filter_account_type: kind,
    multi_company: companyIds ? companyIds.map(id => ({ id })) : [],
  };
  const html = await odoo.execute(modelName, "get_html", [[], options], { context: ctx });
  // Parsear filas para entender la estructura: cada partner con sus 7 buckets
  const htmlStr = String(html);
  const parseAmt = s => {
    if (!s) return 0;
    const norm = s.replace(/\./g, '').replace(',', '.');
    return parseFloat(norm) || 0;
  };
  // Extraer TODAS las filas <tr>...</tr> del HTML
  const trPattern = /<tr\b[\s\S]*?<\/tr>/g;
  const allTrs = htmlStr.match(trPattern) || [];
  const partnerRows = [];
  for (const trHtml of allTrs) {
    // Extraer nombre: primer texto no vacío que no sea vacío
    const textOnly = trHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const cellVals = [...trHtml.matchAll(/o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g)].map(x => parseAmt(x[1]));
    if (cellVals.length >= 7) {
      partnerRows.push({
        text: textOnly.slice(0, 100),
        buckets: cellVals.slice(-7),
        cell_count: cellVals.length,
      });
    }
  }
  // Sumar cada bucket manualmente
  const bucketSums = [0, 0, 0, 0, 0, 0, 0];
  for (const r of partnerRows) {
    for (let i = 0; i < 7; i++) bucketSums[i] += r.buckets[i] || 0;
  }
  // Fila total del reporte (última que tenga clase o_account_report_total)
  const totalRowMatch = htmlStr.match(/<tr[^>]*class="[^"]*o_account_report_total[^"]*"[\s\S]*?<\/tr>/);
  const totalCells = totalRowMatch ? [...totalRowMatch[0].matchAll(/o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g)].map(x => parseAmt(x[1])) : null;

  res.json({
    kind, as_of, companyIds,
    html_length: htmlStr.length,
    partner_rows_count: partnerRows.length,
    bucket_sums_from_partners: {
      current: bucketSums[0],
      d1_30: bucketSums[1],
      d31_60: bucketSums[2],
      d61_90: bucketSums[3],
      d91_120: bucketSums[4],
      older: bucketSums[5],
      total: bucketSums[6],
    },
    total_row_cells: totalCells,
    top_20_by_total: partnerRows
      .filter(r => Math.abs(r.buckets[6]) > 0)
      .sort((a, b) => Math.abs(b.buckets[6]) - Math.abs(a.buckets[6]))
      .slice(0, 20)
      .map(r => ({
        text: r.text, total: r.buckets[6],
        current: r.buckets[0], d1_30: r.buckets[1], d31_60: r.buckets[2],
        d61_90: r.buckets[3], d91_120: r.buckets[4], older: r.buckets[5],
      })),
    top_20_older: partnerRows
      .filter(r => Math.abs(r.buckets[5]) > 0)
      .sort((a, b) => Math.abs(b.buckets[5]) - Math.abs(a.buckets[5]))
      .slice(0, 20)
      .map(r => ({ text: r.text, older: r.buckets[5], total: r.buckets[6], d31_60: r.buckets[2] })),
    top_20_negative_31_60: partnerRows
      .filter(r => r.buckets[2] < 0)
      .sort((a, b) => a.buckets[2] - b.buckets[2])
      .slice(0, 20)
      .map(r => ({ text: r.text, d31_60: r.buckets[2], total: r.buckets[6], older: r.buckets[5] })),
  });
}));

// GET /api/admin/finanzas/ar-ap/diag/odoo — Ejecuta el report EXACTO Aged Receivable de Odoo
app.get("/api/admin/finanzas/ar-ap/diag/odoo", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const ctx = ctxCompanies(companyIds);

  // Odoo v15: model account.aged.partner.balance — no existe como model
  // El reporte usa account.report.aged.trial.balance con context o hits directos a account_move_line
  //
  // Prueba 1: llamar directamente a account.report.aged.receivable con `_get_lines`
  const attempts = {};

  // Attempt A: account.move.line con SOLO account_type=receivable y filter parent_state='posted' y date_maturity
  try {
    const dom = [
      ["parent_state", "=", "posted"],
      ["account_id.internal_type", "=", "receivable"],
      ["date", "<=", as_of],
      ["reconciled", "=", false],
    ];
    if (companyIds) dom.push(["company_id", "in", companyIds]);
    const lines = await odoo.searchRead("account.move.line", dom,
      ["amount_residual", "balance"], { context: ctx, limit: 50000 });
    attempts.internal_type_receivable = {
      count: lines.length,
      sum_residual: lines.reduce((s, l) => s + (l.amount_residual || 0), 0),
      sum_balance: lines.reduce((s, l) => s + (l.balance || 0), 0),
    };
  } catch (e) { attempts.internal_type_receivable = { error: String(e).slice(0,200) }; }

  // Attempt B: mismo pero SIN filter parent_state (incluye drafts?)
  try {
    const dom = [
      ["account_id.user_type_id.type", "=", "receivable"],
      ["date", "<=", as_of],
      ["reconciled", "=", false],
    ];
    if (companyIds) dom.push(["company_id", "in", companyIds]);
    const lines = await odoo.searchRead("account.move.line", dom,
      ["amount_residual", "balance", "parent_state"], { context: ctx, limit: 50000 });
    const posted = lines.filter(l => l.parent_state === "posted");
    const draft = lines.filter(l => l.parent_state === "draft");
    attempts.without_posted_filter = {
      count_total: lines.length,
      count_posted: posted.length,
      count_draft: draft.length,
      sum_residual_all: lines.reduce((s, l) => s + (l.amount_residual || 0), 0),
      sum_residual_posted: posted.reduce((s, l) => s + (l.amount_residual || 0), 0),
      sum_residual_draft: draft.reduce((s, l) => s + (l.amount_residual || 0), 0),
      sum_balance_all: lines.reduce((s, l) => s + (l.balance || 0), 0),
    };
  } catch (e) { attempts.without_posted_filter = { error: String(e).slice(0,200) }; }

  // Attempt C: intentar leer el reporte vía action account_reports
  try {
    // En Odoo v15 con account_reports (Enterprise) existe account.report
    const reports = await odoo.searchRead("ir.model", [["model", "=", "account.aged.receivable"]], ["id", "model"], { limit: 5 });
    attempts.aged_receivable_model_exists = reports.length > 0;
  } catch (e) { attempts.aged_receivable_model_exists = { error: String(e).slice(0,200) }; }

  // Attempt D: sin filtro reconciled, usando full_reconcile_id o matched_debit_ids/matched_credit_ids
  // Simula el SQL del reporte: (lines where reconciled=False) OR (lines fully reconciled after as_of)
  try {
    const dom = [
      ["parent_state", "=", "posted"],
      ["account_id.user_type_id.type", "=", "receivable"],
      ["date", "<=", as_of],
    ];
    if (companyIds) dom.push(["company_id", "in", companyIds]);
    const allLines = await odoo.searchRead("account.move.line", dom,
      ["amount_residual", "balance", "reconciled", "full_reconcile_id", "date", "date_maturity", "id"],
      { context: ctx, limit: 50000 });

    // Para lineas reconciled=true con full_reconcile: verificar si el full reconcile fue DESPUES del as_of
    const reconciledLines = allLines.filter(l => l.reconciled && l.full_reconcile_id && l.full_reconcile_id[0]);
    const fullReconIds = Array.from(new Set(reconciledLines.map(l => l.full_reconcile_id[0])));
    let reversedFromFull = 0;
    if (fullReconIds.length > 0) {
      const fullRecs = await odoo.searchRead("account.full.reconcile",
        [["id", "in", fullReconIds]], ["id", "reconciled_line_ids", "create_date"], { limit: 50000 });
      const fullRecInfo = new Map(fullRecs.map(f => [f.id, f]));
      // Las lineas con full_reconcile creado después del as_of deben incluirse
      for (const line of reconciledLines) {
        const fr = fullRecInfo.get(line.full_reconcile_id[0]);
        if (fr && fr.create_date && fr.create_date.slice(0,10) > as_of) {
          reversedFromFull += line.balance || 0;
        }
      }
    }
    const openLinesSum = allLines.filter(l => !l.reconciled).reduce((s, l) => s + (l.balance || 0), 0);
    const openLinesResidualSum = allLines.filter(l => !l.reconciled).reduce((s, l) => s + (l.amount_residual || 0), 0);
    attempts.reverse_full_recon_after_asof = {
      lines_total: allLines.length,
      lines_open: allLines.filter(l => !l.reconciled).length,
      lines_recon: reconciledLines.length,
      sum_balance_open_only: openLinesSum,
      sum_residual_open_only: openLinesResidualSum,
      reversed_from_full_after_asof: reversedFromFull,
      total_v15_exact: openLinesResidualSum + reversedFromFull,
      total_v15_balance: openLinesSum + reversedFromFull,
    };
  } catch (e) { attempts.reverse_full_recon_after_asof = { error: String(e).slice(0,300) }; }

  // Attempt E: reversar PARTIAL reconciles creados después del as_of (además de full)
  // Odoo Aged Receivable v15 hace: para cada línea, calcular amount_residual como si el as_of fuera hoy
  // Esto significa: si una línea fue parcialmente reconciliada DESPUÉS del as_of, el reporte debe
  // reversar esa parcial y mostrar el residual ORIGINAL (o al as_of).
  try {
    const dom = [
      ["parent_state", "=", "posted"],
      ["account_id.user_type_id.type", "=", "receivable"],
      ["date", "<=", as_of],
    ];
    if (companyIds) dom.push(["company_id", "in", companyIds]);
    const allLines = await odoo.searchRead("account.move.line", dom,
      ["amount_residual", "balance", "reconciled", "full_reconcile_id", "matched_debit_ids", "matched_credit_ids", "date", "id"],
      { context: ctx, limit: 50000 });

    // Recolectar todos los partial_reconcile IDs de líneas open y reconciled
    const allPartialIds = new Set();
    for (const line of allLines) {
      (line.matched_debit_ids || []).forEach(id => allPartialIds.add(id));
      (line.matched_credit_ids || []).forEach(id => allPartialIds.add(id));
    }

    let reversalsAfterAsof = 0;  // total amount to add back
    let partialsAfterCount = 0;
    let partialsAfterTotal = 0;
    if (allPartialIds.size > 0) {
      // Leer partial reconciles en batches
      const partialIdsArr = Array.from(allPartialIds);
      const BATCH = 5000;
      const partialsAfter = [];
      for (let i = 0; i < partialIdsArr.length; i += BATCH) {
        const batch = partialIdsArr.slice(i, i + BATCH);
        const partials = await odoo.searchRead("account.partial.reconcile",
          [["id", "in", batch]],
          ["id", "amount", "debit_move_id", "credit_move_id", "create_date", "max_date"],
          { limit: 50000 });
        for (const p of partials) {
          const pdate = (p.max_date || (p.create_date ? p.create_date.slice(0,10) : null));
          if (pdate && pdate > as_of) {
            partialsAfter.push(p);
            partialsAfterTotal += p.amount || 0;
          }
        }
      }
      partialsAfterCount = partialsAfter.length;
      reversalsAfterAsof = partialsAfterTotal;
    }

    // Sum balance/residual actual
    const currentResidual = allLines.reduce((s, l) => s + (l.amount_residual || 0), 0);
    const currentBalance = allLines.reduce((s, l) => s + (l.balance || 0), 0);

    // Restaurar reversals: si la línea es AR (debit), la partial reduce el residual → sumamos back
    // El signo depende. Simplemente sumamos el monto (positive) al residual actual.
    attempts.reverse_partials_after_asof = {
      lines_total: allLines.length,
      partials_total_ids: allPartialIds.size,
      partials_after_asof: partialsAfterCount,
      reversals_amount: reversalsAfterAsof,
      current_residual: currentResidual,
      current_balance: currentBalance,
      total_with_reversals: currentResidual + reversalsAfterAsof,
      total_balance_with_reversals: currentBalance + reversalsAfterAsof,
    };
  } catch (e) { attempts.reverse_partials_after_asof = { error: String(e).slice(0,300) }; }

  // Attempt F: agrupar por partner y filtrar out los sin partner + drafts. Y con date_maturity
  try {
    const dom = [
      ["parent_state", "=", "posted"],
      ["account_id.user_type_id.type", "=", "receivable"],
      ["date", "<=", as_of],
      ["partner_id", "!=", false],
      ["full_reconcile_id", "=", false],
    ];
    if (companyIds) dom.push(["company_id", "in", companyIds]);
    const lines = await odoo.searchRead("account.move.line", dom,
      ["amount_residual", "balance", "partner_id", "date_maturity"], { context: ctx, limit: 50000 });
    const groups = new Map();
    for (const l of lines) {
      const pid = l.partner_id ? l.partner_id[0] : 0;
      const cur = groups.get(pid) || { residual: 0, balance: 0, count: 0 };
      cur.residual += l.amount_residual || 0;
      cur.balance += l.balance || 0;
      cur.count += 1;
      groups.set(pid, cur);
    }
    // Aged receivable NO netea partners con saldo positivo y negativo por defecto — muestra todo
    // Pero SI netea líneas dentro de la misma línea (residual ya es neto).
    attempts.by_partner_no_null = {
      count_lines: lines.length,
      count_partners: groups.size,
      sum_residual: lines.reduce((s, l) => s + (l.amount_residual || 0), 0),
      sum_balance: lines.reduce((s, l) => s + (l.balance || 0), 0),
      // Top partners con mayor deuda
      top_5_partners: Array.from(groups.entries())
        .sort((a,b) => b[1].residual - a[1].residual)
        .slice(0, 5)
        .map(([pid, v]) => ({ partner_id: pid, residual: v.residual, count: v.count })),
    };
  } catch (e) { attempts.by_partner_no_null = { error: String(e).slice(0,300) }; }

  // Attempt H: search_read contra el MODELO abstracto account.aged.receivable
  // Este modelo abstracto ES el que usa el reporte de Odoo v15
  // REQUIERE report_options con filter_account_type en el context
  try {
    const reportOptions = {
      date: { date_to: as_of, filter: "custom", mode: "single", date_from: as_of },
      all_entries: false,
      unfold_all: false,
      unposted_in_period: false,
      partner_ids: null,
      partner_categories: null,
      analytic_accounts: null,
      analytic_tags: null,
      journals: [],
      filter_account_type: "receivable",
      account_type: [{ id: "trade_receivable", selected: true }],
      multi_company: [{ id: 12, name: "COPIKON C.A." }],
    };
    // Primero: descubrir todos los fields del modelo
    let fieldNames = [];
    try {
      const fg = await odoo.execute("account.aged.receivable", "fields_get", [], { attributes: ["string", "type", "store"] });
      fieldNames = Object.entries(fg).map(([n, f]) => ({ name: n, type: f.type, string: f.string, store: f.store }));
    } catch (e) { fieldNames = [{ error: String(e) }]; }

    const testContexts = [
      { name: "filter_receivable", ctx: { ...ctx, report_options: reportOptions, model: "account.aged.receivable" } },
    ];
    const results = [];
    for (const { name, ctx: c } of testContexts) {
      try {
        // Probamos varios dominios para ver cuál cuadra con Odoo $660,136.26
        const doms = [
          { n: "date_only", d: [["date", "<=", as_of]] },
          { n: "date_full_reconcile", d: [["date", "<=", as_of], ["full_reconcile_id", "=", false]] },
          { n: "date_reconciled", d: [["date", "<=", as_of], ["reconciled", "=", false]] },
        ];
        for (const { n, d } of doms) {
          try {
            const lns = await odoo.searchRead("account.aged.receivable", d,
              ["balance", "partner_id"], { context: c, limit: 30000 });
            const byP = new Map();
            for (const l of lns) {
              const p = l.partner_id ? l.partner_id[0] : 0;
              byP.set(p, (byP.get(p) || 0) + (l.balance || 0));
            }
            const totalNet = Array.from(byP.values()).reduce((s,b) => s+b, 0);
            const onlyPos = Array.from(byP.values()).filter(b => b > 0).reduce((s,b) => s+b, 0);
            results.push({
              domain: n,
              lines: lns.length,
              partners: byP.size,
              sum_balance_lines: lns.reduce((s,l) => s + (l.balance || 0), 0),
              net_by_partner: totalNet,
              positive_partners_only: onlyPos,
            });
          } catch (e) { results.push({ domain: n, error: String(e).slice(0,200) }); }
        }
      } catch (e) { results.push({ ctx: name, error: String(e).slice(0,300) }); }
    }
    attempts.abstract_aged_receivable = { fields: fieldNames.slice(0, 40), results };
  } catch (e) { attempts.abstract_aged_receivable = { error: String(e).slice(0,300) }; }

  // Attempt J: llamar get_html() del reporte con options apropiadas
  try {
    // Odoo Enterprise v15: account.aged.receivable.get_html(options) devuelve HTML del reporte
    const options = {
      date: { date_to: as_of, filter: "custom", mode: "single", string: as_of },
      all_entries: false,
      unfold_all: false,
      unposted_in_period: false,
      partner_ids: null,
      partner_categories: null,
      analytic_accounts: null,
      analytic_tags: null,
      journals: [],
      filter_account_type: "receivable",
      multi_company: [{ id: 12, name: "COPIKON C.A." }],
    };
    try {
      const html = await odoo.execute("account.aged.receivable", "get_html", [[], options], { context: ctx });
      const htmlStr = String(html);
      // El reporte de Odoo tiene una fila "Total" al final con la totalización
      // Buscar la línea de total y sus valores
      // Típicamente: <tr class="o_account_reports_totals ..."> con "Total" en primera celda
      // o <tfoot> con los totales
      
      // Extraer todos los montos del footer/total
      // El formato es "$ 660.136,26" o "$ 660,136.26"
      const totalMatches = [];
      // Buscar todas las ocurrencias de "Total" cerca de montos
      const totalPattern = /Total[^<]{0,50}<[^>]*>[^<]*<[^>]*>\s*\$?\s*([\d,\.]+)/gi;
      let m;
      while ((m = totalPattern.exec(htmlStr)) !== null) {
        totalMatches.push(m[1]);
      }
      
      // Alternativa: extraer las últimas 6-7 celdas del HTML (footer del reporte)
      // Odoo Aged tiene columnas: Partner, Not Due, 1-30, 31-60, 61-90, 91-120, Older, Total
      const lastCells = [];
      const cellPattern = /o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g;
      const allCells = [];
      while ((m = cellPattern.exec(htmlStr)) !== null) {
        allCells.push(m[1]);
      }
      
      // El reporte agrupa por partner, cada partner tiene 6 columnas (aging + total)
      // La última fila con class "o_account_reports_totals" tiene los subtotales
      // Buscamos el patrón de la fila de totales
      const totalRowMatch = htmlStr.match(/<tr[^>]*class="[^"]*o_account_reports_totals[^"]*"[^>]*>([\s\S]{0,2000}?)<\/tr>/);
      let totalRowValues = [];
      if (totalRowMatch) {
        const rowHtml = totalRowMatch[1];
        const values = [];
        let vm;
        const vp = /o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)/g;
        while ((vm = vp.exec(rowHtml)) !== null) values.push(vm[1]);
        totalRowValues = values;
      }
      
      attempts.get_html_result = {
        html_length: htmlStr.length,
        total_row_values: totalRowValues,
        total_matches_from_pattern: totalMatches.slice(0, 10),
        all_cells_count: allCells.length,
        last_10_cells: allCells.slice(-10),
        // Buscar todos los montos > 1000
        big_amounts: allCells.filter(a => {
          const n = parseFloat(a.replace(/\./g, '').replace(',', '.'));
          return !isNaN(n) && n > 100000;
        }).slice(0, 20),
      };
    } catch (e) { attempts.get_html_result = { error: String(e).slice(0, 500) }; }
  } catch (e) { attempts.get_html_result = { error: String(e).slice(0, 300) }; }

  // Attempt G: intentar llamar directamente el reporte Aged Receivable de Odoo
  // En Odoo 15 (Community o Enterprise), el reporte se ejecuta vía wizard/model.
  try {
    // Estrategias a probar:
    //   1. account.aged.receivable  (Enterprise v14/v15)
    //   2. account.aged.partner.balance / accounting.report (Community v15)
    //   3. account.report (Enterprise v16+, pero puede estar retro-portado)
    const found = [];
    for (const modelName of [
      "account.aged.receivable",
      "account.aged.payable",
      "account.aged.partner.balance",
      "account.aged.trial.balance",
      "account.report.aged.receivable",
      "account.report.aged.payable",
      "accounting.report",
      "account.common.report",
      "account.common.partner.report",
      "account.report",
      "account.report.general.ledger",
    ]) {
      try {
        const r = await odoo.execute(modelName, "fields_get", [], { attributes: ["string", "type"] });
        found.push({ model: modelName, fields: Object.keys(r).slice(0, 20) });
      } catch (e) {
        // silently skip
      }
    }
    attempts.available_report_models = found;
  } catch (e) { attempts.available_report_models = { error: String(e).slice(0,300) }; }

  res.json({ filters: { company_ids: companyIds, as_of }, attempts });
}));

// GET /api/admin/finanzas/ar-ap/diag/lines — Exporta líneas AR/AP abiertas para reconciliar
// vs el Aged Receivable de Odoo. Query: kind=receivable|payable, as_of, company_id
app.get("/api/admin/finanzas/ar-ap/diag/lines", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const kind = String(req.query.kind || "receivable");
  const ctx = ctxCompanies(companyIds);

  const dom = [
    ["parent_state", "=", "posted"],
    ["reconciled", "=", false],
    ["date", "<=", as_of],
    ["account_id.user_type_id.type", "=", kind],
  ];
  if (companyIds) dom.push(["company_id", "in", companyIds]);

  const lines = await odoo.searchRead("account.move.line",
    dom,
    ["id", "move_id", "move_name", "partner_id", "account_id", "journal_id",
     "balance", "amount_residual", "debit", "credit",
     "date", "date_maturity", "name", "ref"],
    { context: ctx, limit: 50000, order: "date asc" });

  // Buscar move_type para clasificar
  const moveIds = Array.from(new Set(lines.map(l => l.move_id?.[0]).filter(Boolean)));
  const moves = await odoo.searchRead("account.move",
    [["id", "in", moveIds]],
    ["id", "move_type", "state", "payment_state", "invoice_date"],
    { context: ctx, limit: 50000 });
  const moveInfo = new Map(moves.map(m => [m.id, m]));

  // Agrupar por tipo de asiento y ver la suma
  const groups = {};
  for (const l of lines) {
    const mi = moveInfo.get(l.move_id?.[0]) || {};
    const key = `${mi.move_type || "entry"}_${l.journal_id?.[1] || "?"}`;
    if (!groups[key]) groups[key] = { count: 0, sum_balance: 0, sum_residual: 0 };
    groups[key].count++;
    groups[key].sum_balance += l.balance || 0;
    groups[key].sum_residual += l.amount_residual || 0;
  }

  // Lineas sin partner_id (Odoo Aged excluye estas)
  const noPartner = lines.filter(l => !l.partner_id || !l.partner_id[0]);
  const noPartnerSum = {
    count: noPartner.length,
    sum_balance: noPartner.reduce((s, l) => s + (l.balance || 0), 0),
    sum_residual: noPartner.reduce((s, l) => s + (l.amount_residual || 0), 0),
  };

  // Lineas de tipo "entry" (asientos manuales) vs invoices
  const byType = { invoice: { count: 0, sum_residual: 0 }, entry: { count: 0, sum_residual: 0 }, other: { count: 0, sum_residual: 0 } };
  for (const l of lines) {
    const mi = moveInfo.get(l.move_id?.[0]) || {};
    const t = mi.move_type || "entry";
    const cat = (t === "out_invoice" || t === "out_refund" || t === "in_invoice" || t === "in_refund") ? "invoice"
      : t === "entry" ? "entry" : "other";
    byType[cat].count++;
    byType[cat].sum_residual += l.amount_residual || 0;
  }

  res.json({
    filters: { company_ids: companyIds, as_of, kind },
    total_lines: lines.length,
    total_balance: lines.reduce((s, l) => s + (l.balance || 0), 0),
    total_residual: lines.reduce((s, l) => s + (l.amount_residual || 0), 0),
    lines_without_partner: noPartnerSum,
    by_move_type: byType,
    groups_by_type_journal: groups,
    sample_no_partner: noPartner.slice(0, 20).map(l => ({
      id: l.id, move: l.move_name, journal: l.journal_id?.[1],
      balance: l.balance, residual: l.amount_residual, date: l.date, name: l.name, ref: l.ref,
    })),
  });
}));

// GET /api/admin/finanzas/ar-ap/diag — Diagnóstico: compara 4 fórmulas de CxC/CxP
// para identificar la discrepancia con el Aged Receivable de Odoo.
app.get("/api/admin/finanzas/ar-ap/diag", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const ctx = ctxCompanies(companyIds);

  const baseDom = [["parent_state", "=", "posted"]];
  if (companyIds) baseDom.push(["company_id", "in", companyIds]);

  const results = {};

  for (const kind of ["receivable", "payable"]) {
    const typeFilter = ["account_id.user_type_id.type", "=", kind];
    const sign = kind === "receivable" ? 1 : -1;

    // F1: gl_balance = sum(balance) hasta as_of (sin filtrar reconciled)
    const glLines = await odoo.searchRead("account.move.line",
      [...baseDom, ["date", "<=", as_of], typeFilter],
      ["balance"], { context: ctx, limit: 50000 });
    const f1 = glLines.reduce((s, l) => s + (l.balance || 0), 0) * sign;

    // F2: sum(amount_residual) de lineas NO reconciliadas con date <= as_of (nuestro nuevo KPI)
    const openLinesDated = await odoo.searchRead("account.move.line",
      [...baseDom, ["reconciled", "=", false], ["date", "<=", as_of], typeFilter],
      ["amount_residual"], { context: ctx, limit: 50000 });
    const f2 = openLinesDated.reduce((s, l) => s + (l.amount_residual || 0), 0) * sign;

    // F3: sum(amount_residual) de lineas NO reconciliadas SIN filtro de fecha (viejo KPI)
    const openLinesAll = await odoo.searchRead("account.move.line",
      [...baseDom, ["reconciled", "=", false], typeFilter],
      ["amount_residual"], { context: ctx, limit: 50000 });
    const f3 = openLinesAll.reduce((s, l) => s + (l.amount_residual || 0), 0) * sign;

    // F4: sum(balance) de lineas NO reconciliadas con date <= as_of (equivalente Aged Odoo con historicos)
    const openLinesBal = await odoo.searchRead("account.move.line",
      [...baseDom, ["reconciled", "=", false], ["date", "<=", as_of], typeFilter],
      ["balance"], { context: ctx, limit: 50000 });
    const f4 = openLinesBal.reduce((s, l) => s + (l.balance || 0), 0) * sign;

    // F6: Aged Receivable v15 EXACT — usa read_group para replicar SQL de Odoo
    const openLinesV15 = await odoo.searchRead("account.move.line",
      [...baseDom, ["full_reconcile_id", "=", false], ["date", "<=", as_of], typeFilter],
      ["amount_residual", "balance"], { context: ctx, limit: 50000 });
    const f6_residual = openLinesV15.reduce((s, l) => s + (l.amount_residual || 0), 0) * sign;
    const f6_balance = openLinesV15.reduce((s, l) => s + (l.balance || 0), 0) * sign;

    // F7: Aged Receivable HISTÓRICO — replica exactamente Odoo Aged Receivable v15
    // Lógica: sum(balance) de TODAS las lineas AR con date<=as_of
    //         MENOS sum(balance) de reconciliaciones (partial_reconcile) con max_date<=as_of
    // Esto reconstruye el saldo al as_of ignorando pagos aplicados posteriormente.
    const allLinesInDate = await odoo.searchRead("account.move.line",
      [...baseDom, ["date", "<=", as_of], typeFilter],
      ["id", "balance", "amount_residual", "full_reconcile_id"],
      { context: ctx, limit: 50000 });
    const f7_all_balance = allLinesInDate.reduce((s, l) => s + (l.balance || 0), 0) * sign;
    const reconciled_count = allLinesInDate.filter(l => l.full_reconcile_id && l.full_reconcile_id[0]).length;
    const unreconciled_count = allLinesInDate.length - reconciled_count;

    // F8: Aged Receivable EXACT — F7 sin reversar reconciliaciones posteriores + amount_residual
    // El truco: para lineas con `date <= as_of` pero reconciliadas después del as_of, Odoo usa balance (no residual)
    // porque amount_residual es el residual actual (después de pagos posteriores).
    // Nosotros no tenemos forma fácil de saber cuándo se reconcilió sin traer account.partial.reconcile.
    // Así que traemos partial.reconcile con debit_move_id o credit_move_id en las lineas AR:
    const arLineIds = allLinesInDate.map(l => l.id);
    let f8_exact = 0;
    if (arLineIds.length > 0) {
      // Traer partial reconcile posteriores al as_of
      const partialsAfter = await odoo.searchRead("account.partial.reconcile",
        [
          "|", ["debit_move_id", "in", arLineIds], ["credit_move_id", "in", arLineIds],
          ["max_date", ">", as_of],
        ],
        ["id", "amount", "debit_amount_currency", "credit_amount_currency", "max_date",
         "debit_move_id", "credit_move_id"],
        { context: ctx, limit: 50000 });
      // Ajustar: para cada partial posterior al as_of, sumar el monto de vuelta al residual de la linea AR
      const arLineIdSet = new Set(arLineIds);
      let reversedAmount = 0;
      for (const p of partialsAfter) {
        const dbId = p.debit_move_id?.[0];
        const crId = p.credit_move_id?.[0];
        // Si la linea AR está del lado debit (factura) y el credito (pago) es posterior, el balance no cambia pero residual sí
        // El pago reduce el residual de la linea AR en `amount`
        if (arLineIdSet.has(dbId) || arLineIdSet.has(crId)) {
          reversedAmount += p.amount || 0;
        }
      }
      const currentResidual = allLinesInDate.reduce((s, l) => s + (l.amount_residual || 0), 0);
      f8_exact = (currentResidual + reversedAmount) * sign;
    }

    // F5: Aged Receivable Odoo exact — agrupa por partner, excluye partners con saldo negativo (neto anticipo)
    const openLinesPartner = await odoo.searchRead("account.move.line",
      [...baseDom, ["reconciled", "=", false], ["date", "<=", as_of], typeFilter],
      ["amount_residual", "partner_id"], { context: ctx, limit: 50000 });
    const partnerSums = new Map();
    for (const l of openLinesPartner) {
      const pid = l.partner_id?.[0] || 0;
      partnerSums.set(pid, (partnerSums.get(pid) || 0) + (l.amount_residual || 0) * sign);
    }
    let f5_positive_only = 0, f5_all = 0;
    let partnersPositive = 0, partnersNegative = 0;
    for (const v of partnerSums.values()) {
      f5_all += v;
      if (v > 0) { f5_positive_only += v; partnersPositive++; }
      else if (v < 0) partnersNegative++;
    }

    results[kind] = {
      f1_gl_balance_asof: f1,
      f2_residual_open_dated: f2,
      f3_residual_open_alltime: f3,
      f4_balance_open_dated: f4,
      f5_partner_positive_only: f5_positive_only,
      f5_partner_all: f5_all,
      partners_positive: partnersPositive,
      partners_negative: partnersNegative,
      lines_open_dated: openLinesDated.length,
      lines_open_all: openLinesAll.length,
      f6_residual_no_fullreconcile: f6_residual,
      f6_balance_no_fullreconcile: f6_balance,
      f7_all_lines_balance: f7_all_balance,
      f7_lines_count: allLinesInDate.length,
      f7_reconciled_count: reconciled_count,
      f7_unreconciled_count: unreconciled_count,
      f8_exact_aged_receivable: f8_exact,
      lines_v15: openLinesV15.length,
    };
  }

  res.json({
    filters: { company_ids: companyIds, as_of },
    legend: {
      f1_gl_balance_asof: "Balance General de Odoo (sum balance en cta AR/AP hasta as_of)",
      f2_residual_open_dated: "KPI actual: sum(amount_residual) de lineas NO reconciliadas con date <= as_of",
      f3_residual_open_alltime: "KPI viejo: sum(amount_residual) NO reconc SIN filtro de fecha",
      f4_balance_open_dated: "Aged Receivable Odoo: sum(balance) NO reconciliadas hasta as_of",
      f5_partner_positive_only: "Aged Receivable exact: sum por partner, solo partners con saldo positivo (excluye partners con anticipo neto)",
      f5_partner_all: "Aged Receivable con anticipos netos: sum por partner incluyendo negativos",
    },
    results,
  });
}));

// GET /api/admin/finanzas/cashflow — Flujo de caja y saldos bancarios
// Query params: company_id, date_from, date_to
app.get("/api/admin/finanzas/cashflow", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const date_from = String(req.query.date_from || firstDayOfMonthIso());
  const date_to = String(req.query.date_to || todayIso());
  const ctx = ctxCompanies(companyIds);

  // Cuentas de banco/caja: internal_type = 'liquidity' (bancos y cajas)
  const accountDomain = [["internal_type", "=", "liquidity"]];
  if (companyIds) accountDomain.push(["company_id", "in", companyIds]);

  const bankAccounts = await odoo.searchRead(
    "account.account",
    accountDomain,
    ["id", "code", "name", "company_id", "currency_id"],
    { context: ctx, order: "code asc", limit: 200 }
  );

  if (bankAccounts.length === 0) {
    return res.json({
      filters: { company_ids: companyIds, date_from, date_to },
      bank_accounts: [], totals: { opening: 0, inflows: 0, outflows: 0, closing: 0, net_change: 0 },
      by_journal: [],
    });
  }

  const bankAccIds = bankAccounts.map(a => a.id);

  // Saldo apertura: suma de balance hasta date_from-1
  const openingDomain = [
    ["parent_state", "=", "posted"],
    ["date", "<", date_from],
    ["account_id", "in", bankAccIds],
  ];
  if (companyIds) openingDomain.push(["company_id", "in", companyIds]);

  // Movimientos del período
  const periodDomain = [
    ["parent_state", "=", "posted"],
    ["date", ">=", date_from],
    ["date", "<=", date_to],
    ["account_id", "in", bankAccIds],
  ];
  if (companyIds) periodDomain.push(["company_id", "in", companyIds]);

  const [openingGroups, byAccountGroups, byJournalGroups] = await Promise.all([
    odoo.readGroup(
      "account.move.line", openingDomain,
      ["balance:sum"], [], { context: ctx, lazy: false }
    ),
    odoo.readGroup(
      "account.move.line", periodDomain,
      ["debit:sum", "credit:sum", "balance:sum", "account_id"],
      ["account_id"],
      { context: ctx, lazy: false, limit: 200 }
    ),
    odoo.readGroup(
      "account.move.line", periodDomain,
      ["debit:sum", "credit:sum", "balance:sum", "journal_id"],
      ["journal_id"],
      { context: ctx, lazy: false, limit: 100 }
    ),
  ]);

  const opening = openingGroups[0]?.balance || 0;

  const movementsByAccount = new Map();
  for (const g of byAccountGroups) {
    movementsByAccount.set(g.account_id?.[0], {
      inflows: g.debit || 0,
      outflows: g.credit || 0,
      net: g.balance || 0,
    });
  }

  // También necesitamos saldo apertura por cuenta
  const openingByAcc = await odoo.readGroup(
    "account.move.line", openingDomain,
    ["balance:sum", "account_id"], ["account_id"],
    { context: ctx, lazy: false, limit: 200 }
  );
  const openingByAccMap = new Map();
  for (const g of openingByAcc) openingByAccMap.set(g.account_id?.[0], g.balance || 0);

  const bankRows = bankAccounts.map(a => {
    const m = movementsByAccount.get(a.id) || { inflows: 0, outflows: 0, net: 0 };
    const op = openingByAccMap.get(a.id) || 0;
    return {
      account_id: a.id,
      code: a.code,
      name: a.name,
      company_id: a.company_id?.[0],
      company_name: a.company_id?.[1],
      currency: a.currency_id?.[1] || null,
      opening_balance: op,
      inflows: m.inflows,
      outflows: m.outflows,
      net_change: m.net,
      closing_balance: op + m.net,
    };
  });

  const totalInflows = bankRows.reduce((s, r) => s + r.inflows, 0);
  const totalOutflows = bankRows.reduce((s, r) => s + r.outflows, 0);
  const totalClosing = bankRows.reduce((s, r) => s + r.closing_balance, 0);
  const totalOpening = bankRows.reduce((s, r) => s + r.opening_balance, 0);

  const byJournal = byJournalGroups.map(g => ({
    journal_id: g.journal_id?.[0],
    journal_name: g.journal_id?.[1],
    inflows: g.debit || 0,
    outflows: g.credit || 0,
    net: g.balance || 0,
  })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  res.json({
    filters: { company_ids: companyIds, date_from, date_to },
    bank_accounts: bankRows,
    by_journal: byJournal,
    totals: {
      opening: totalOpening,
      inflows: totalInflows,
      outflows: totalOutflows,
      net_change: totalInflows - totalOutflows,
      closing: totalClosing,
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/tesoreria/conciliacion
// Estado de conciliación por banco: contable (account.move.line reconciled)
// + bancaria (account.bank.statement.line is_reconciled) + partidas en tránsito
// Query params: company_id (opcional), as_of (default hoy)
// ─────────────────────────────────────────────────────────────────────
app.get("/api/admin/tesoreria/conciliacion", wrap(async (req, res) => {
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const ctx = ctxCompanies(companyIds);

  // 1) Cuentas de banco/caja (liquidity + código 111xxx/112xxx que son Caja/Bancos)
  //    Odoo marca como "liquidity" también algunas cuentas de anticipos; filtramos por código.
  const bankAccDomain = [
    ["internal_type", "=", "liquidity"],
    "|", ["code", "=like", "111%"], ["code", "=like", "112%"],
  ];
  if (companyIds) bankAccDomain.push(["company_id", "in", companyIds]);
  const bankAccounts = await odoo.searchRead(
    "account.account",
    bankAccDomain,
    ["id", "code", "name", "company_id", "currency_id"],
    { context: ctx, order: "code asc", limit: 300 }
  );

  // 2) Cuentas 131xxx (Recibos y Pagos pendientes = tránsito)
  const transitDomain = [["code", "=like", "131%"]];
  if (companyIds) transitDomain.push(["company_id", "in", companyIds]);
  const transitAccounts = await odoo.searchRead(
    "account.account",
    transitDomain,
    ["id", "code", "name"],
    { context: ctx, order: "code asc", limit: 200 }
  );
  const transitByCode = {};
  transitAccounts.forEach(a => { transitByCode[a.code] = a; });

  // 3) Journals bancarios (para conciliación bancaria)
  const journalDomain = [["type", "in", ["bank", "cash"]]];
  if (companyIds) journalDomain.push(["company_id", "in", companyIds]);
  const journals = await odoo.searchRead(
    "account.journal",
    journalDomain,
    ["id", "name", "code", "type", "default_account_id", "currency_id", "company_id"],
    { context: ctx, order: "code asc", limit: 200 }
  );

  const bankAccIds = bankAccounts.map(a => a.id);
  const journalIds = journals.map(j => j.id);

  // 4) Líneas contables abiertas por cuenta (reconciled = false, con date <= as_of)
  const openLinesDomain = [
    ["parent_state", "=", "posted"],
    ["date", "<=", as_of],
    ["account_id", "in", bankAccIds],
    ["reconciled", "=", false],
  ];
  if (companyIds) openLinesDomain.push(["company_id", "in", companyIds]);
  const openByAccount = bankAccIds.length ? await odoo.readGroup(
    "account.move.line",
    openLinesDomain,
    ["balance:sum", "amount_residual:sum", "account_id"],
    ["account_id"],
    { context: ctx, lazy: false, limit: 500 }
  ) : [];

  // 5) Líneas contables reconciliadas (informativo - conteo)
  const reconLinesDomain = [
    ["parent_state", "=", "posted"],
    ["date", "<=", as_of],
    ["account_id", "in", bankAccIds],
    ["reconciled", "=", true],
  ];
  if (companyIds) reconLinesDomain.push(["company_id", "in", companyIds]);
  const reconByAccount = bankAccIds.length ? await odoo.readGroup(
    "account.move.line",
    reconLinesDomain,
    ["balance:sum", "account_id"],
    ["account_id"],
    { context: ctx, lazy: false, limit: 500 }
  ) : [];

  // 6) Líneas del extracto bancario pendientes (account.bank.statement.line, is_reconciled=false)
  //    Odoo v15+: es_reconciled indica si la línea del extracto ya fue aplicada a asientos.
  const stmtLineDomain = [
    ["journal_id", "in", journalIds],
    ["date", "<=", as_of],
    ["is_reconciled", "=", false],
  ];
  if (companyIds) stmtLineDomain.push(["company_id", "in", companyIds]);

  let stmtPending = [];
  try {
    stmtPending = journalIds.length ? await odoo.readGroup(
      "account.bank.statement.line",
      stmtLineDomain,
      ["amount:sum", "journal_id"],
      ["journal_id"],
      { context: ctx, lazy: false, limit: 500 }
    ) : [];
  } catch (e) {
    // Si el campo is_reconciled no existe en esta versión, dejar vacío.
    stmtPending = [];
  }

  // 7) Última fecha de conciliación por cuenta (última línea reconciliada)
  let lastReconByAccount = {};
  if (bankAccIds.length) {
    try {
      const lastLines = await odoo.searchRead(
        "account.move.line",
        [
          ["parent_state", "=", "posted"],
          ["account_id", "in", bankAccIds],
          ["reconciled", "=", true],
          ["full_reconcile_id", "!=", false],
        ],
        ["account_id", "date"],
        { context: ctx, order: "date desc", limit: 2000 }
      );
      for (const l of lastLines) {
        const aid = l.account_id?.[0];
        if (!aid) continue;
        if (!lastReconByAccount[aid] || l.date > lastReconByAccount[aid]) {
          lastReconByAccount[aid] = l.date;
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 7b) Partida abierta más antigua por cuenta (primera fecha sin conciliar)
  //     Y separación cobros (debit > 0) vs pagos (credit > 0)
  const oldestOpenByAccount = {};
  const cobrosOpenByAccount = {}; // debit > 0 (entradas al banco)
  const pagosOpenByAccount = {};  // credit > 0 (salidas del banco)
  if (bankAccIds.length) {
    try {
      const oldestLines = await odoo.searchRead(
        "account.move.line",
        [
          ["parent_state", "=", "posted"],
          ["account_id", "in", bankAccIds],
          ["reconciled", "=", false],
          ["date", "<=", as_of],
          ...(companyIds ? [["company_id", "in", companyIds]] : []),
        ],
        ["account_id", "date", "debit", "credit"],
        { context: ctx, order: "date asc", limit: 20000 }
      );
      for (const l of oldestLines) {
        const aid = l.account_id?.[0];
        if (!aid) continue;
        if (!oldestOpenByAccount[aid]) oldestOpenByAccount[aid] = l.date;
        if ((l.debit || 0) > 0) {
          if (!cobrosOpenByAccount[aid]) cobrosOpenByAccount[aid] = { count: 0, amount: 0 };
          cobrosOpenByAccount[aid].count++;
          cobrosOpenByAccount[aid].amount += (l.debit || 0);
        }
        if ((l.credit || 0) > 0) {
          if (!pagosOpenByAccount[aid]) pagosOpenByAccount[aid] = { count: 0, amount: 0 };
          pagosOpenByAccount[aid].count++;
          pagosOpenByAccount[aid].amount += (l.credit || 0);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 8) Balance total por cuenta (para GL balance)
  const balDomain = [
    ["parent_state", "=", "posted"],
    ["date", "<=", as_of],
    ["account_id", "in", bankAccIds],
  ];
  if (companyIds) balDomain.push(["company_id", "in", companyIds]);
  const balByAccount = bankAccIds.length ? await odoo.readGroup(
    "account.move.line",
    balDomain,
    ["balance:sum", "account_id"],
    ["account_id"],
    { context: ctx, lazy: false, limit: 500 }
  ) : [];

  // Indexar por account_id
  const balMap = {}, openMap = {}, reconMap = {};
  balByAccount.forEach(g => {
    balMap[g.account_id?.[0]] = { balance: g.balance || 0, count: g.__count || 0 };
  });
  openByAccount.forEach(g => {
    openMap[g.account_id?.[0]] = {
      balance: g.balance || 0,
      residual: g.amount_residual || 0,
      count: g.__count || 0,
    };
  });
  reconByAccount.forEach(g => {
    reconMap[g.account_id?.[0]] = { balance: g.balance || 0, count: g.__count || 0 };
  });

  // Indexar pendientes de extracto por journal → default_account_id
  const stmtPendingByJournal = {};
  stmtPending.forEach(g => {
    stmtPendingByJournal[g.journal_id?.[0]] = {
      amount: g.amount || 0,
      count: g.__count || 0,
    };
  });
  const journalByDefaultAccount = {};
  journals.forEach(j => {
    const aid = j.default_account_id?.[0];
    if (aid) journalByDefaultAccount[aid] = j;
  });

  // Ensamblar filas por cuenta bancaria
  const rows = bankAccounts.map(acc => {
    const bal = balMap[acc.id] || { balance: 0, count: 0 };
    const open = openMap[acc.id] || { balance: 0, residual: 0, count: 0 };
    const recon = reconMap[acc.id] || { balance: 0, count: 0 };
    const journal = journalByDefaultAccount[acc.id];
    const stmt = journal ? stmtPendingByJournal[journal.id] : null;

    // Buscar cuenta tránsito con código análogo (ej. 112108 → 131208)
    // Regla observada: 111xxx caja, 112xxx bancos, 131xxx tránsito con últimos 3 dígitos correlativos.
    const codeSuffix = String(acc.code || "").slice(-2);
    let transitAcc = null;
    for (const t of transitAccounts) {
      if (String(t.code || "").endsWith(codeSuffix) && String(t.code || "").startsWith("131")) {
        transitAcc = t;
        break;
      }
    }

    // Determinar estado global
    const openCount = open.count || 0;
    const openAbs = Math.abs(open.balance || 0);
    const stmtCount = stmt?.count || 0;
    const stmtAbs = Math.abs(stmt?.amount || 0);

    let status = "conciliado";
    if (openCount > 0 && openAbs > 1) status = "pendiente";
    if (stmtCount > 0) status = "pendiente";
    if (openCount === 0 && stmtCount === 0) status = "conciliado";
    if (openCount > 100 || stmtCount > 50) status = "crítico";

    // Cálculo de días de atraso
    const asOfDate = new Date(as_of);
    const lastReconDate = lastReconByAccount[acc.id] ? new Date(lastReconByAccount[acc.id]) : null;
    const oldestOpenDate = oldestOpenByAccount[acc.id] ? new Date(oldestOpenByAccount[acc.id]) : null;
    const daysSinceLastRecon = lastReconDate
      ? Math.floor((asOfDate.getTime() - lastReconDate.getTime()) / 86400000) : null;
    const daysOldestOpen = oldestOpenDate
      ? Math.floor((asOfDate.getTime() - oldestOpenDate.getTime()) / 86400000) : null;

    const cobros = cobrosOpenByAccount[acc.id] || { count: 0, amount: 0 };
    const pagos = pagosOpenByAccount[acc.id] || { count: 0, amount: 0 };

    return {
      account_id: acc.id,
      account_code: acc.code,
      account_name: acc.name,
      company_id: acc.company_id?.[0],
      currency: acc.currency_id?.[1] || null,
      gl_balance: bal.balance || 0,
      gl_lines_total: bal.count || 0,
      open_balance: open.balance || 0,
      open_residual: open.residual || 0,
      open_lines: open.count || 0,
      reconciled_lines: recon.count || 0,
      reconciled_balance: recon.balance || 0,
      last_reconciled_date: lastReconByAccount[acc.id] || null,
      oldest_open_date: oldestOpenByAccount[acc.id] || null,
      days_since_last_recon: daysSinceLastRecon,
      days_oldest_open: daysOldestOpen,
      cobros_pendientes_count: cobros.count,
      cobros_pendientes_amount: cobros.amount,
      pagos_pendientes_count: pagos.count,
      pagos_pendientes_amount: pagos.amount,
      journal_id: journal?.id || null,
      journal_name: journal?.name || null,
      stmt_pending_lines: stmt?.count || 0,
      stmt_pending_amount: stmt?.amount || 0,
      transit_account_code: transitAcc?.code || null,
      transit_account_name: transitAcc?.name || null,
      status,
    };
  });

  // Totales globales
  const totals = {
    accounts: rows.length,
    gl_balance: rows.reduce((s, r) => s + r.gl_balance, 0),
    open_lines: rows.reduce((s, r) => s + r.open_lines, 0),
    open_balance: rows.reduce((s, r) => s + r.open_balance, 0),
    reconciled_lines: rows.reduce((s, r) => s + r.reconciled_lines, 0),
    stmt_pending_lines: rows.reduce((s, r) => s + r.stmt_pending_lines, 0),
    stmt_pending_amount: rows.reduce((s, r) => s + r.stmt_pending_amount, 0),
    accounts_pending: rows.filter(r => r.status !== "conciliado").length,
    accounts_conciliadas: rows.filter(r => r.status === "conciliado").length,
    accounts_criticas: rows.filter(r => r.status === "crítico").length,
  };

  // Ordenar por atraso: primero por días de partida más antigua abierta (desc)
  rows.sort((a, b) => (b.days_oldest_open || 0) - (a.days_oldest_open || 0));

  res.json({
    filters: { company_ids: companyIds, as_of },
    totals,
    rows,
    journals: journals.map(j => ({
      id: j.id, code: j.code, name: j.name, type: j.type,
      default_account_id: j.default_account_id?.[0],
    })),
  });
}));

// ───────────────────────────────────────────────────────
// GET /api/admin/tesoreria/conciliacion/detalle/:accountId
// Lista de partidas contables abiertas de UNA cuenta bancaria, separadas
// en cobros (debit > 0) y pagos (credit > 0)
// ───────────────────────────────────────────────────────
app.get("/api/admin/tesoreria/conciliacion/detalle/:accountId", wrap(async (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: "accountId inválido" });
  }
  const companyIds = parseCompanyIds(req.query);
  const as_of = String(req.query.as_of || todayIso());
  const ctx = ctxCompanies(companyIds);
  const limit = Math.min(Number(req.query.limit) || 500, 2000);

  const domain = [
    ["parent_state", "=", "posted"],
    ["account_id", "=", accountId],
    ["reconciled", "=", false],
    ["date", "<=", as_of],
  ];
  if (companyIds) domain.push(["company_id", "in", companyIds]);

  const lines = await odoo.searchRead(
    "account.move.line",
    domain,
    [
      "id", "date", "name", "ref", "debit", "credit", "amount_residual",
      "partner_id", "move_id", "journal_id", "balance",
    ],
    { context: ctx, order: "date asc", limit }
  );

  // Info de la cuenta
  const accs = await odoo.searchRead(
    "account.account", [["id", "=", accountId]],
    ["id", "code", "name", "currency_id"],
    { context: ctx, limit: 1 }
  );
  const account = accs[0] || null;

  // Separar en cobros (debit>0) y pagos (credit>0)
  const cobros = [];
  const pagos = [];
  for (const l of lines) {
    const row = {
      id: l.id,
      date: l.date,
      name: l.name || "",
      ref: l.ref || "",
      partner_id: l.partner_id?.[0] || null,
      partner_name: l.partner_id?.[1] || null,
      move_id: l.move_id?.[0] || null,
      move_name: l.move_id?.[1] || null,
      debit: l.debit || 0,
      credit: l.credit || 0,
      amount_residual: l.amount_residual || 0,
      balance: l.balance || 0,
      journal_name: l.journal_id?.[1] || null,
    };
    if (row.debit > 0) cobros.push(row);
    if (row.credit > 0) pagos.push(row);
  }

  const totalCobros = cobros.reduce((s, r) => s + r.debit, 0);
  const totalPagos = pagos.reduce((s, r) => s + r.credit, 0);

  res.json({
    account,
    filters: { company_ids: companyIds, as_of, limit },
    cobros: {
      count: cobros.length,
      amount: totalCobros,
      lines: cobros,
    },
    pagos: {
      count: pagos.length,
      amount: totalPagos,
      lines: pagos,
    },
    total_lines: lines.length,
  });
}));

const PORT = process.env.PORT || 5050;

// ═══════════════════════════════════════════════════════════════════
// AUTO-MATCH DE CONCILIACIÓN BANCARIA
// Flujo: parse extracto → match contra Odoo → export XLSX Odoo
// ═══════════════════════════════════════════════════════════════════

// ───────── Helpers de parsing ─────────
function parseNumber(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  const str = String(s).trim().replace(/[^\d,.\-]/g, "");
  if (!str) return null;
  // Detectar formato: 1.234,56 (VE/EU) vs 1,234.56 (US)
  const lastComma = str.lastIndexOf(",");
  const lastDot = str.lastIndexOf(".");
  let norm;
  if (lastComma > lastDot) {
    // VE/EU: coma es decimal
    norm = str.replace(/\./g, "").replace(",", ".");
  } else {
    // US: punto es decimal
    norm = str.replace(/,/g, "");
  }
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
}

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s.toISOString().slice(0, 10);
  const str = String(s).trim();
  // ISO YYYY-MM-DD
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY o DD-MM-YYYY
  m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // MM/DD/YYYY (US) — cuando el primer número es > 12 asumimos DD/MM
  return null;
}

// Parsear texto de PDF: heurística basada en líneas con fecha + monto
function parsePdfText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  const dateRe = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}-\d{2}-\d{2})/;
  const amountRe = /(-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/g;

  for (const line of lines) {
    const dm = line.match(dateRe);
    if (!dm) continue;
    const date = parseDate(dm[1]);
    if (!date) continue;
    // Buscar 1-3 montos en la línea; el último suele ser saldo, penúltimo débito/crédito
    const amounts = [...line.matchAll(amountRe)].map(m => parseNumber(m[1])).filter(n => n !== null);
    if (amounts.length === 0) continue;
    // Descripción: quitar fecha y montos
    let desc = line.replace(dateRe, "").replace(amountRe, "").replace(/\s+/g, " ").trim();
    // Heurística: si hay 2+ montos, el último es saldo, el anterior es el movimiento
    let amount;
    if (amounts.length >= 2) {
      amount = amounts[amounts.length - 2];
    } else {
      amount = amounts[0];
    }
    // Detectar signo por palabras clave
    const upper = desc.toUpperCase();
    let signHint = 0;
    if (/DEBIT|CARGO|RETIRO|COMISION|PAGO|TRANS.*EMIT/i.test(upper)) signHint = -1;
    if (/CREDIT|ABONO|DEPOSITO|TRANS.*RECIB|COBRO/i.test(upper)) signHint = 1;
    if (signHint !== 0 && Math.sign(amount) !== signHint) amount = signHint * Math.abs(amount);
    rows.push({ date, description: desc.slice(0, 200), ref: "", amount });
  }
  return rows;
}

// Parsear XLSX: buscar columnas por nombre
function parseXlsxBuffer(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    if (!json.length) continue;
    // Buscar fila header (contiene "fecha" o "date")
    let headerRow = -1;
    for (let i = 0; i < Math.min(json.length, 20); i++) {
      const cells = json[i].map(c => String(c).toLowerCase());
      if (cells.some(c => /fecha|date/i.test(c))) {
        headerRow = i;
        break;
      }
    }
    if (headerRow < 0) continue;
    const headers = json[headerRow].map(c => String(c).toLowerCase().trim());
    // Localizar índices de columnas por nombre
    const findCol = (patterns) => headers.findIndex(h => patterns.some(p => h.includes(p)));
    const iDate = findCol(["fecha", "date"]);
    const iDesc = findCol(["descripc", "concepto", "descripti", "detalle", "narr"]);
    const iRef = findCol(["ref", "documento", "operaci", "comprobante"]);
    const iDebit = findCol(["debit", "cargo", "salida", "retiro"]);
    const iCredit = findCol(["credit", "abono", "entrada", "deposito"]);
    const iAmount = findCol(["monto", "importe", "amount"]);
    if (iDate < 0) continue;
    for (let i = headerRow + 1; i < json.length; i++) {
      const row = json[i];
      if (!row || !row[iDate]) continue;
      const date = parseDate(row[iDate]);
      if (!date) continue;
      let amount;
      if (iDebit >= 0 || iCredit >= 0) {
        const debit = parseNumber(row[iDebit]) || 0;
        const credit = parseNumber(row[iCredit]) || 0;
        // Débito = salida = negativo; Crédito = entrada = positivo
        amount = credit - debit;
      } else if (iAmount >= 0) {
        amount = parseNumber(row[iAmount]);
      } else {
        continue;
      }
      if (amount === null || amount === 0) continue;
      rows.push({
        date,
        description: iDesc >= 0 ? String(row[iDesc] || "").slice(0, 200) : "",
        ref: iRef >= 0 ? String(row[iRef] || "").slice(0, 60) : "",
        amount,
      });
    }
  }
  return rows;
}

// Parsear CSV
function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  // Detectar separador
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
  const splitCsv = (l) => {
    const out = [];
    let cur = "", q = false;
    for (const c of l) {
      if (c === '"') q = !q;
      else if (c === sep && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim().replace(/^"|"$/g, ""));
  };
  const parsed = lines.map(splitCsv);
  // Convertir a formato XLSX-like para reusar el parser
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(parsed);
  XLSX.utils.book_append_sheet(wb, ws, "csv");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return parseXlsxBuffer(buf);
}

// ───────── POST /api/admin/tesoreria/automatch/parse ─────────
// Body: { filename: string, content_base64: string }
// Detecta formato por extensión y devuelve filas normalizadas
app.post("/api/admin/tesoreria/automatch/parse", wrap(async (req, res) => {
  const { filename, content_base64 } = req.body || {};
  if (!filename || !content_base64) {
    return res.status(400).json({ error: "filename y content_base64 requeridos" });
  }
  const buf = Buffer.from(content_base64, "base64");
  const ext = filename.toLowerCase().split(".").pop();
  let rows = [];
  let parser_used = "";

  try {
    if (ext === "pdf") {
      const pdfParse = _require("pdf-parse");
      const data = await pdfParse(buf);
      rows = parsePdfText(data.text);
      parser_used = "pdf";
    } else if (ext === "xlsx" || ext === "xls") {
      rows = parseXlsxBuffer(buf);
      parser_used = "xlsx";
    } else if (ext === "csv") {
      rows = parseCsvText(buf.toString("utf8"));
      parser_used = "csv";
    } else if (ext === "txt") {
      rows = parsePdfText(buf.toString("utf8"));
      parser_used = "txt";
    } else {
      return res.status(400).json({ error: `Formato .${ext} no soportado. Usa PDF, XLSX, CSV o TXT.` });
    }
  } catch (e) {
    return res.status(500).json({ error: `Error parseando archivo: ${e.message}` });
  }

  // Ordenar por fecha
  rows.sort((a, b) => a.date.localeCompare(b.date));

  // Estadísticas
  const cobros = rows.filter(r => r.amount > 0);
  const pagos = rows.filter(r => r.amount < 0);

  res.json({
    ok: true,
    parser_used,
    filename,
    stats: {
      total_lines: rows.length,
      cobros_count: cobros.length,
      cobros_amount: cobros.reduce((s, r) => s + r.amount, 0),
      pagos_count: pagos.length,
      pagos_amount: Math.abs(pagos.reduce((s, r) => s + r.amount, 0)),
      date_from: rows[0]?.date || null,
      date_to: rows[rows.length - 1]?.date || null,
    },
    rows,
  });
}));

// ───────── POST /api/admin/tesoreria/automatch/match ─────────
// Body: { company_id, account_id, statement_lines: [{date, description, ref, amount}] }
// Devuelve 3 grupos: sure_matches, possible_matches, no_match
app.post("/api/admin/tesoreria/automatch/match", wrap(async (req, res) => {
  const { company_id, account_id, statement_lines } = req.body || {};
  const companyId = Number(company_id);
  const accountId = Number(account_id);
  if (!Number.isFinite(companyId) || !Number.isFinite(accountId)) {
    return res.status(400).json({ error: "company_id y account_id requeridos" });
  }
  if (!Array.isArray(statement_lines) || statement_lines.length === 0) {
    return res.status(400).json({ error: "statement_lines requeridas" });
  }

  // 1) Traer apuntes abiertos de Odoo para esta cuenta
  const odooLines = await odoo.searchRead(
    "account.move.line",
    [
      ["account_id", "=", accountId],
      ["company_id", "=", companyId],
      ["parent_state", "=", "posted"],
      ["reconciled", "=", false],
      ["full_reconcile_id", "=", false],
    ],
    ["id", "date", "name", "ref", "debit", "credit", "move_name", "partner_id", "amount_residual"],
    { limit: 5000, order: "date asc" }
  );

  // Normalizar: crear signed_amount (debit=entrada al banco=positivo; credit=salida=negativo)
  const odooPool = odooLines.map(l => ({
    id: l.id,
    date: l.date,
    signed_amount: (l.debit || 0) - (l.credit || 0),
    debit: l.debit || 0,
    credit: l.credit || 0,
    name: l.name || "",
    ref: l.ref || "",
    move_name: l.move_name || "",
    partner_name: Array.isArray(l.partner_id) ? l.partner_id[1] : "",
    matched: false,
  }));

  // 2) Matching por 3 pasadas
  // Pasada 1: monto exacto (±0.01) + fecha exacta o ±3 días
  // Pasada 2: monto exacto ±0.01 + fecha ±15 días
  // Pasada 3: monto ±1% + fecha ±3 días
  const sure = [];
  const possible = [];
  const noMatch = [];

  const daysBetween = (d1, d2) => {
    const a = new Date(d1), b = new Date(d2);
    return Math.abs((a - b) / (1000 * 60 * 60 * 24));
  };

  const findMatch = (stmt, tolerance) => {
    // tolerance: { amountAbs, amountPct, dayWindow }
    const candidates = [];
    for (const line of odooPool) {
      if (line.matched) continue;
      const amountDiff = Math.abs(line.signed_amount - stmt.amount);
      const amountPct = Math.abs(stmt.amount) > 0 ? amountDiff / Math.abs(stmt.amount) : 1;
      const dayDiff = daysBetween(stmt.date, line.date);
      if (amountDiff <= tolerance.amountAbs && dayDiff <= tolerance.dayWindow) {
        candidates.push({ line, amountDiff, dayDiff, score: dayDiff * 10 + amountDiff });
      } else if (amountPct <= tolerance.amountPct && dayDiff <= tolerance.dayWindow) {
        candidates.push({ line, amountDiff, dayDiff, score: dayDiff * 10 + amountDiff + 5 });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
  };

  // Enriquecer statement con id local
  const stmtLines = statement_lines.map((s, i) => ({ ...s, stmt_idx: i }));

  // Pasada 1: matches seguros
  for (const stmt of stmtLines) {
    const m = findMatch(stmt, { amountAbs: 0.01, amountPct: 0, dayWindow: 3 });
    if (m) {
      m.line.matched = true;
      sure.push({
        stmt_idx: stmt.stmt_idx,
        statement: stmt,
        odoo_line: m.line,
        confidence: "sure",
        amount_diff: m.amountDiff,
        day_diff: m.dayDiff,
      });
    }
  }

  // Pasada 2 y 3: para las statements sin match seguro, buscar posibles
  const matchedStmts = new Set(sure.map(s => s.stmt_idx));
  for (const stmt of stmtLines) {
    if (matchedStmts.has(stmt.stmt_idx)) continue;
    // Pasada 2: monto exacto, ventana ±15 días
    let m = findMatch(stmt, { amountAbs: 0.01, amountPct: 0, dayWindow: 15 });
    // Pasada 3: monto ±1%, ventana ±3 días
    if (!m) m = findMatch(stmt, { amountAbs: 0, amountPct: 0.01, dayWindow: 3 });
    if (m) {
      m.line.matched = true;
      possible.push({
        stmt_idx: stmt.stmt_idx,
        statement: stmt,
        odoo_line: m.line,
        confidence: "possible",
        amount_diff: m.amountDiff,
        day_diff: m.dayDiff,
      });
      matchedStmts.add(stmt.stmt_idx);
    }
  }

  // Sin match
  for (const stmt of stmtLines) {
    if (matchedStmts.has(stmt.stmt_idx)) continue;
    noMatch.push({ stmt_idx: stmt.stmt_idx, statement: stmt });
  }

  // Apuntes de Odoo que no matcharon con ningún statement
  const unmatchedOdoo = odooPool.filter(l => !l.matched);

  res.json({
    ok: true,
    account_id: accountId,
    company_id: companyId,
    stats: {
      statement_lines: stmtLines.length,
      odoo_open_lines: odooLines.length,
      sure_matches: sure.length,
      possible_matches: possible.length,
      no_match_statements: noMatch.length,
      unmatched_odoo_lines: unmatchedOdoo.length,
    },
    sure_matches: sure,
    possible_matches: possible,
    no_match_statements: noMatch,
    unmatched_odoo_lines: unmatchedOdoo,
  });
}));

// ───────── POST /api/admin/tesoreria/automatch/export-odoo ─────────
// Body: { account_code, account_name, statement_date, approved_matches: [{statement, odoo_move_name, odoo_line_id}] }
// Devuelve XLSX con formato importable en Odoo
app.post("/api/admin/tesoreria/automatch/export-odoo", wrap(async (req, res) => {
  const { account_code, account_name, statement_date, approved_matches } = req.body || {};
  if (!Array.isArray(approved_matches) || approved_matches.length === 0) {
    return res.status(400).json({ error: "approved_matches requeridas" });
  }

  // Hoja 1: Statement lines para importar
  const stmtRows = [
    ["Fecha", "Referencia externa", "Descripción", "Contraparte", "Monto (USD)", "Apunte Odoo (move_name)", "Odoo line_id", "Confianza"],
    ...approved_matches.map(m => [
      m.statement?.date || "",
      m.statement?.ref || "",
      m.statement?.description || "",
      m.odoo_line?.partner_name || "",
      m.statement?.amount || 0,
      m.odoo_line?.move_name || "",
      m.odoo_line?.id || "",
      m.confidence || "manual",
    ]),
  ];

  // Hoja 2: Resumen
  const cobros = approved_matches.filter(m => (m.statement?.amount || 0) > 0);
  const pagos = approved_matches.filter(m => (m.statement?.amount || 0) < 0);
  const sumCobros = cobros.reduce((s, m) => s + (m.statement?.amount || 0), 0);
  const sumPagos = pagos.reduce((s, m) => s + Math.abs(m.statement?.amount || 0), 0);
  const summaryRows = [
    ["Concepto", "Valor"],
    ["Cuenta bancaria", `${account_code} — ${account_name}`],
    ["Fecha de conciliación", statement_date || new Date().toISOString().slice(0, 10)],
    ["Total movimientos", approved_matches.length],
    ["Cobros (entradas)", cobros.length],
    ["Monto cobros", sumCobros],
    ["Pagos (salidas)", pagos.length],
    ["Monto pagos", sumPagos],
    ["Neto", sumCobros - sumPagos],
    ["Generado", new Date().toISOString()],
  ];

  // Hoja 3: Instrucciones para el contador
  const instrucciones = [
    ["Instrucciones para aplicar en Odoo"],
    [""],
    ["1. Abre Odoo → Contabilidad → Diario contable de la cuenta bancaria"],
    ["2. Localiza cada apunte por su 'move_name' (columna F de la hoja 'Matches')"],
    ["3. Marca cada apunte como conciliado con el movimiento del extracto correspondiente"],
    ["4. Para conciliación masiva: usa el menú Odoo → Contabilidad → Conciliación Bancaria"],
    ["5. Los apuntes con Odoo line_id (columna G) están listos para conciliar 1-a-1"],
    [""],
    ["Confianza: 'sure' = match automático de alta confianza (mismo monto, ≤3 días)"],
    ["Confianza: 'possible' = requiere validación manual"],
    ["Confianza: 'manual' = aprobado manualmente por el usuario"],
    [""],
    [`Cuenta: ${account_code} — ${account_name}`],
    [`Generado: ${new Date().toISOString()}`],
    [`Total: ${approved_matches.length} movimientos`],
  ];

  const wb = XLSX.utils.book_new();
  const wsStmt = XLSX.utils.aoa_to_sheet(stmtRows);
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  const wsInstr = XLSX.utils.aoa_to_sheet(instrucciones);
  XLSX.utils.book_append_sheet(wb, wsSummary, "Resumen");
  XLSX.utils.book_append_sheet(wb, wsStmt, "Matches");
  XLSX.utils.book_append_sheet(wb, wsInstr, "Instrucciones");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="conciliacion_${account_code}_${(statement_date || "").replace(/-/g, "")}.xlsx"`);
  res.send(buf);
}));


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
