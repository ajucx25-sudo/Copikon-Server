// ============================================================
// Playbooks Comerciales — Copikon
// ============================================================
// Módulo de seguimiento de KPIs para campañas de venta impulsadas
// desde Comercialización. Cada playbook define: producto(s), meta,
// unidad de negocio, ventana temporal, comisiones y bonos.
//
// El backend consume ventas reales desde Odoo (`sale.order.line`)
// filtradas por SKU + fecha + almacén, calcula KPIs derivados
// (avance, ritmo, cobertura de vendedores, ranking) y persiste
// snapshots agregados por playbook en la tabla `kv`.
//
// Colecciones kv usadas:
//   - `playbooks`                     → array de configs
//   - `playbook-sales:<id>`           → últimas ventas sincronizadas
//   - `playbook-daily-snapshot:<id>`  → serie diaria agregada
//   - `playbook-commissions:<id>:<yyyy-mm>` → cierre mensual comisiones
// ============================================================

import * as odoo from "./odoo-client.js";

// Configuración inicial precargada al arranque (idempotente).
// Piloto Barquisimeto — replicable a otras plazas cambiando warehouseCode.
const PILOT_COMMISSIONS = {
  vendedor: {
    basePct: 0.015,               // 1.5% sobre subtotal
    sobrestockMultiplier: 1.5,    // aplicable a productos con flag sobrestock
    mayorFlatPerUnitUsd: 1.0,     // +$1/uds en canal mayorista
    institucionalFlatPerUnitUsd: 1.5, // +$1.50/uds en canal institucional
    referidoNuevoFlatUsd: 30,     // $30 fijo por cliente referido nuevo
  },
  coordinador: {
    // Comisión plana por tramo de venta total del playbook (mes).
    // Ambos (vendedor y coord/gerente) cobran completa.
    bands: [
      { fromUsd: 0,       toUsd: 25000,  pct: 0.000 },
      { fromUsd: 25001,   toUsd: 50000,  pct: 0.002 },
      { fromUsd: 50001,   toUsd: 100000, pct: 0.0035 },
      { fromUsd: 100001,  toUsd: null,   pct: 0.005 },
    ],
  },
  bonoMetaMensual: {
    // Aplica al pool coordinador/gerente. Se calcula sobre % de meta alcanzada.
    tiers: [
      { name: "Base",       fromPct: 0.70, toPct: 0.9999, poolUsd: 60 },
      { name: "Meta",       fromPct: 1.00, toPct: 1.2999, poolUsd: 150 },
      { name: "Sobre-meta", fromPct: 1.30, toPct: 1.5999, poolUsd: 260 },
      { name: "Excelencia", fromPct: 1.60, toPct: null,   poolUsd: 380 },
    ],
  },
};

const SEED_PLAYBOOKS = [
  {
    id: "stanley-40oz-bto-2026q3",
    name: "Stanley 40oz — Piloto Barquisimeto",
    productLine: "Vasos Térmicos Stanley 40oz",
    category: "retail-mayor-institucional",
    unitKey: "copikon-ca",
    warehouseCode: "BTO",         // Almacén Barquisimeto en Odoo
    warehouseName: "Barquisimeto",
    campaignTag: "stanley-bto",   // utm_campaign / analytic tag en Odoo
    skus: [
      { code: "STAN40-BLK", label: "Stanley 40oz Negro" },
      { code: "STAN40-RED", label: "Stanley 40oz Rojo" },
      { code: "STAN40-WHT", label: "Stanley 40oz Blanco" },
      { code: "STAN40-BLU", label: "Stanley 40oz Azul" },
    ],
    startDate: "2026-08-04",
    endDate:   "2026-11-01",
    targetUnits: 1900,
    targetMonthly: [
      { month: "2026-08", units: 500 },
      { month: "2026-09", units: 650 },
      { month: "2026-10", units: 750 },
    ],
    pricing: {
      costUsd: 12.5,
      pvpDetalUsd: 24.9,
      pvpMayorUsd: 20.0,
      pvpInstitucionalUsd: 18.5,
    },
    commissions: PILOT_COMMISSIONS,
    channels: ["detal", "mayor", "institucional"],
    status: "activo",
    createdAt: null,   // rellenado en seed
    createdBy: "seed",
  },
  {
    id: "conos-seguridad-bto-2026q3",
    name: "Conos de Seguridad TRAFFCONE — Piloto Barquisimeto",
    productLine: "Conos de Seguridad PVC",
    category: "institucional-mayor",
    unitKey: "copikon-ca",
    warehouseCode: "BTO",
    warehouseName: "Barquisimeto",
    campaignTag: "conos-bto",
    skus: [
      { code: "TRAFFCONE50", label: "Cono PVC 50cm" },
      { code: "TRAFFCONE70", label: "Cono PVC 70cm" },
    ],
    startDate: "2026-08-04",
    endDate:   "2026-11-01",
    targetUnits: 1900,
    targetMonthly: [
      { month: "2026-08", units: 500 },
      { month: "2026-09", units: 650 },
      { month: "2026-10", units: 750 },
    ],
    pricing: {
      // Rango de costo/PVP — los conos tienen 2 SKUs con distinto costo.
      costUsd: 4.7,
      pvpDetalUsd: 9.0,
      pvpMayorUsd: 7.5,
      pvpInstitucionalUsd: 6.8,
    },
    commissions: PILOT_COMMISSIONS,
    channels: ["mayor", "institucional"],
    status: "activo",
    createdAt: null,
    createdBy: "seed",
  },
];

// ────────────────────────────────────────────────────────────
// Helpers de cálculo
// ────────────────────────────────────────────────────────────

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function monthOf(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

function nowIso() {
  return new Date().toISOString();
}

// Suma unidades y valor de un arreglo de líneas ya normalizadas.
function sumLines(lines) {
  let units = 0, valueUsd = 0;
  for (const l of lines) {
    units += Number(l.qty) || 0;
    valueUsd += Number(l.subtotal) || 0;
  }
  return { units, valueUsd };
}

// Devuelve la meta del mes según la tabla `targetMonthly` del playbook.
function monthlyTarget(playbook, month) {
  const row = (playbook.targetMonthly || []).find((r) => r.month === month);
  return row ? Number(row.units) || 0 : 0;
}

// Calcula ritmo teórico esperado a la fecha (unidades esperadas
// linealmente entre startDate y endDate).
function expectedPace(playbook, now = new Date()) {
  const start = new Date(playbook.startDate + "T00:00:00Z").getTime();
  const end   = new Date(playbook.endDate   + "T23:59:59Z").getTime();
  const t     = Math.max(start, Math.min(now.getTime(), end));
  const totalMs = end - start;
  if (totalMs <= 0) return { fraction: 1, expectedUnits: playbook.targetUnits };
  const fraction = (t - start) / totalMs;
  return {
    fraction,
    expectedUnits: Math.round(playbook.targetUnits * fraction),
  };
}

// Aplica tramo de comisión plana coordinador/gerente.
function coordinatorPct(totalUsd, bands) {
  for (const b of bands) {
    const hi = b.toUsd == null ? Infinity : b.toUsd;
    if (totalUsd >= b.fromUsd && totalUsd <= hi) return b.pct;
  }
  return 0;
}

// Devuelve el tier de bono según % meta alcanzada.
function bonusTier(pctAttained, tiers) {
  for (const t of tiers) {
    const hi = t.toPct == null ? Infinity : t.toPct;
    if (pctAttained >= t.fromPct && pctAttained <= hi) return t;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Sync desde Odoo — trae sale.order.line filtradas y las
// normaliza para que el frontend no vuelva a consultar Odoo.
// ────────────────────────────────────────────────────────────

async function fetchOdooPlaybookSales(playbook) {
  if (!odoo.isConfigured()) {
    throw new Error("Odoo no configurado (variables ODOO_URL/DB/LOGIN/API_KEY)");
  }

  const skuCodes = (playbook.skus || []).map((s) => s.code).filter(Boolean);
  if (!skuCodes.length) return { lines: [], meta: { skipped: "no-skus" } };

  // 1) Localizar productos por default_code
  const products = await odoo.searchRead(
    "product.product",
    [["default_code", "in", skuCodes]],
    ["id", "default_code", "name", "uom_id"],
    { limit: 500 }
  );
  if (!products.length) return { lines: [], meta: { skipped: "no-products-in-odoo", skuCodes } };
  const productIds = products.map((p) => p.id);
  const productByOdooId = new Map(products.map((p) => [p.id, p]));

  // 2) Localizar almacén por código para restringir órdenes
  //    (opcional — si no aparece, no filtramos por almacén y avisamos en meta)
  let warehouseId = null;
  let warehouseWarning = null;
  if (playbook.warehouseCode) {
    const whs = await odoo.searchRead(
      "stock.warehouse",
      [["code", "=", playbook.warehouseCode]],
      ["id", "code", "name"],
      { limit: 5 }
    );
    if (whs.length) warehouseId = whs[0].id;
    else warehouseWarning = `warehouse code '${playbook.warehouseCode}' no encontrado en Odoo`;
  }

  // 3) Traer líneas de venta en el rango de fechas
  const startDT = playbook.startDate + " 00:00:00";
  const endDT   = playbook.endDate   + " 23:59:59";
  const domain = [
    ["product_id", "in", productIds],
    ["order_id.date_order", ">=", startDT],
    ["order_id.date_order", "<=", endDT],
    ["state", "in", ["sale", "done"]],
  ];
  if (warehouseId) domain.push(["order_id.warehouse_id", "=", warehouseId]);

  const rawLines = await odoo.searchRead(
    "sale.order.line",
    domain,
    [
      "id", "order_id", "product_id", "product_uom_qty",
      "price_subtotal", "price_total", "salesman_id", "team_id",
      "date_order", "state",
    ],
    { order: "date_order desc", limit: 20000 }
  );

  // 4) Traer info extra de la orden (partner, canal, referido)
  const orderIds = Array.from(new Set(rawLines
    .map((l) => Array.isArray(l.order_id) ? l.order_id[0] : null)
    .filter(Boolean)));
  const orders = orderIds.length ? await odoo.searchRead(
    "sale.order",
    [["id", "in", orderIds]],
    ["id", "name", "partner_id", "user_id", "team_id", "date_order",
     "warehouse_id", "amount_total", "campaign_id"],
    { limit: 20000 }
  ) : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const lines = rawLines.map((l) => {
    const orderId = Array.isArray(l.order_id) ? l.order_id[0] : null;
    const order = orderId ? orderById.get(orderId) : null;
    const productOdooId = Array.isArray(l.product_id) ? l.product_id[0] : null;
    const prod = productOdooId ? productByOdooId.get(productOdooId) : null;
    const sku = prod?.default_code || null;
    const skuMeta = (playbook.skus || []).find((s) => s.code === sku) || null;
    return {
      lineId: l.id,
      orderId,
      orderName: order?.name || (Array.isArray(l.order_id) ? l.order_id[1] : null),
      dateOrder: l.date_order || order?.date_order,
      sku,
      productLabel: skuMeta?.label || prod?.name || (Array.isArray(l.product_id) ? l.product_id[1] : null),
      qty: Number(l.product_uom_qty) || 0,
      subtotal: Number(l.price_subtotal) || 0,
      total: Number(l.price_total) || 0,
      salespersonId: Array.isArray(l.salesman_id) ? l.salesman_id[0] : null,
      salespersonName: Array.isArray(l.salesman_id) ? l.salesman_id[1] : null,
      teamId: Array.isArray(l.team_id) ? l.team_id[0] : null,
      teamName: Array.isArray(l.team_id) ? l.team_id[1] : null,
      partnerId: order && Array.isArray(order.partner_id) ? order.partner_id[0] : null,
      partnerName: order && Array.isArray(order.partner_id) ? order.partner_id[1] : null,
      campaign: order && Array.isArray(order.campaign_id) ? order.campaign_id[1] : null,
      state: l.state,
    };
  });

  return {
    lines,
    meta: {
      skuCodes,
      productCount: products.length,
      orderCount: orders.length,
      lineCount: lines.length,
      warehouseId,
      warehouseWarning,
    },
  };
}

// Agrega ventas por día para gráfico de avance.
function buildDailySnapshot(playbook, lines) {
  const byDate = new Map();
  for (const l of lines) {
    const d = ymd(l.dateOrder);
    if (!byDate.has(d)) byDate.set(d, { date: d, units: 0, valueUsd: 0, orders: new Set() });
    const entry = byDate.get(d);
    entry.units += l.qty;
    entry.valueUsd += l.subtotal;
    if (l.orderId) entry.orders.add(l.orderId);
  }
  const series = Array.from(byDate.values())
    .map((r) => ({ date: r.date, units: r.units, valueUsd: r.valueUsd, orders: r.orders.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Acumulado
  let acc = 0, accValue = 0;
  for (const p of series) {
    acc += p.units;
    accValue += p.valueUsd;
    p.cumUnits = acc;
    p.cumValueUsd = accValue;
  }
  return series;
}

// Ranking de vendedores.
function buildLeaderboard(lines) {
  const byPerson = new Map();
  for (const l of lines) {
    const id = l.salespersonId || 0;
    const name = l.salespersonName || "Sin asignar";
    if (!byPerson.has(id)) {
      byPerson.set(id, {
        salespersonId: id,
        salespersonName: name,
        units: 0,
        valueUsd: 0,
        orders: new Set(),
        skusHit: new Set(),
      });
    }
    const p = byPerson.get(id);
    p.units += l.qty;
    p.valueUsd += l.subtotal;
    if (l.orderId) p.orders.add(l.orderId);
    if (l.sku) p.skusHit.add(l.sku);
  }
  return Array.from(byPerson.values())
    .map((p) => ({
      salespersonId: p.salespersonId,
      salespersonName: p.salespersonName,
      units: p.units,
      valueUsd: Number(p.valueUsd.toFixed(2)),
      orders: p.orders.size,
      skusCovered: p.skusHit.size,
    }))
    .sort((a, b) => b.units - a.units);
}

// Métrica de cobertura por SKU (¿todas las referencias están rotando?)
function buildSkuCoverage(playbook, lines) {
  const byCode = new Map();
  for (const s of (playbook.skus || [])) byCode.set(s.code, { sku: s.code, label: s.label, units: 0, valueUsd: 0 });
  for (const l of lines) {
    if (!l.sku || !byCode.has(l.sku)) continue;
    const e = byCode.get(l.sku);
    e.units += l.qty;
    e.valueUsd += l.subtotal;
  }
  return Array.from(byCode.values()).map((e) => ({
    ...e,
    valueUsd: Number(e.valueUsd.toFixed(2)),
  }));
}

// KPIs derivados globales.
function buildKpis(playbook, lines) {
  const totals = sumLines(lines);
  const pace = expectedPace(playbook);
  const pctAttained = playbook.targetUnits > 0 ? totals.units / playbook.targetUnits : 0;
  const gap = totals.units - pace.expectedUnits;
  const coverage = buildSkuCoverage(playbook, lines);
  const activeSkus = coverage.filter((c) => c.units > 0).length;
  const salespeople = new Set(lines.map((l) => l.salespersonId).filter(Boolean));
  return {
    updatedAt: nowIso(),
    windowStart: playbook.startDate,
    windowEnd: playbook.endDate,
    targetUnits: playbook.targetUnits,
    unitsSold: totals.units,
    valueUsd: Number(totals.valueUsd.toFixed(2)),
    pctAttained: Number(pctAttained.toFixed(4)),
    expectedUnitsToDate: pace.expectedUnits,
    paceGapUnits: gap,
    paceGapPct: pace.expectedUnits > 0 ? Number(((totals.units - pace.expectedUnits) / pace.expectedUnits).toFixed(4)) : 0,
    skusActive: activeSkus,
    skusTotal: (playbook.skus || []).length,
    salespeopleActive: salespeople.size,
    ordersCount: new Set(lines.map((l) => l.orderId).filter(Boolean)).size,
  };
}

// Cálculo de comisiones por mes.
function computeCommissions(playbook, lines, monthStr) {
  const monthLines = lines.filter((l) => monthOf(l.dateOrder) === monthStr);
  const totalUsd = monthLines.reduce((s, l) => s + l.subtotal, 0);
  const totalUnits = monthLines.reduce((s, l) => s + l.qty, 0);

  // 1) Comisión vendedor — base % sobre subtotal
  const vendedorBaseTotal = totalUsd * playbook.commissions.vendedor.basePct;

  // Detalle por vendedor
  const byPerson = new Map();
  for (const l of monthLines) {
    const id = l.salespersonId || 0;
    if (!byPerson.has(id)) {
      byPerson.set(id, {
        salespersonId: id,
        salespersonName: l.salespersonName || "Sin asignar",
        units: 0, valueUsd: 0, baseUsd: 0,
      });
    }
    const p = byPerson.get(id);
    p.units += l.qty;
    p.valueUsd += l.subtotal;
    p.baseUsd += l.subtotal * playbook.commissions.vendedor.basePct;
  }

  // 2) Comisión coord/gerente — banda plana sobre total del mes
  const coordPct = coordinatorPct(totalUsd, playbook.commissions.coordinador.bands);
  const coordUsd = totalUsd * coordPct;

  // 3) Bono meta mensual
  const meta = monthlyTarget(playbook, monthStr);
  const pctMeta = meta > 0 ? totalUnits / meta : 0;
  const tier = bonusTier(pctMeta, playbook.commissions.bonoMetaMensual.tiers);
  const bonoUsd = tier ? tier.poolUsd : 0;

  return {
    month: monthStr,
    totalUsd: Number(totalUsd.toFixed(2)),
    totalUnits,
    targetUnits: meta,
    pctMeta: Number(pctMeta.toFixed(4)),
    vendedor: {
      basePct: playbook.commissions.vendedor.basePct,
      baseUsd: Number(vendedorBaseTotal.toFixed(2)),
      detalle: Array.from(byPerson.values()).map((p) => ({
        salespersonId: p.salespersonId,
        salespersonName: p.salespersonName,
        units: p.units,
        valueUsd: Number(p.valueUsd.toFixed(2)),
        baseUsd: Number(p.baseUsd.toFixed(2)),
      })).sort((a, b) => b.baseUsd - a.baseUsd),
    },
    coordinador: {
      appliedPct: coordPct,
      appliedUsd: Number(coordUsd.toFixed(2)),
    },
    bonoMeta: tier ? {
      tier: tier.name,
      poolUsd: tier.poolUsd,
      awarded: bonoUsd > 0,
    } : { tier: null, poolUsd: 0, awarded: false },
    totalPayoutUsd: Number((vendedorBaseTotal + coordUsd + bonoUsd).toFixed(2)),
    computedAt: nowIso(),
  };
}

// ────────────────────────────────────────────────────────────
// Registro de rutas
// ────────────────────────────────────────────────────────────

export function registerPlaybooks(app, { pool, readCol, writeCol, wrap }) {

  // Seed idempotente al arranque del módulo.
  (async () => {
    try {
      const existing = await readCol("playbooks");
      if (existing && existing.length) {
        console.log(`[playbooks] ${existing.length} playbooks existentes, skip seed`);
        return;
      }
      const now = Date.now();
      const seeded = SEED_PLAYBOOKS.map((p) => ({ ...p, createdAt: now }));
      await writeCol("playbooks", seeded);
      console.log(`[playbooks] seeded ${seeded.length} playbooks piloto`);
    } catch (e) {
      console.error("[playbooks] seed error:", e?.message);
    }
  })();

  // ── CRUD de playbooks ──────────────────────────────────────
  // (El CRUD genérico de server.js no cubre esto porque el playbook
  // usa id string y necesitamos endpoints derivados por :id.)

  app.get("/api/playbooks", wrap(async (_req, res) => {
    const items = await readCol("playbooks");
    res.json(items);
  }));

  app.get("/api/playbooks/:id", wrap(async (req, res) => {
    const items = await readCol("playbooks");
    const item = items.find((x) => String(x.id) === String(req.params.id));
    if (!item) return res.status(404).json({ message: "playbook no encontrado" });
    res.json(item);
  }));

  app.post("/api/playbooks", wrap(async (req, res) => {
    const items = await readCol("playbooks");
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ message: "id requerido (string)" });
    if (items.some((x) => String(x.id) === String(body.id))) {
      return res.status(409).json({ message: "id ya existe" });
    }
    const created = {
      commissions: PILOT_COMMISSIONS,
      status: "activo",
      createdAt: Date.now(),
      createdBy: body.createdBy || "manual",
      ...body,
    };
    items.push(created);
    await writeCol("playbooks", items);
    res.status(201).json(created);
  }));

  app.patch("/api/playbooks/:id", wrap(async (req, res) => {
    const items = await readCol("playbooks");
    const idx = items.findIndex((x) => String(x.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ message: "playbook no encontrado" });
    items[idx] = { ...items[idx], ...(req.body || {}), id: items[idx].id, updatedAt: Date.now() };
    await writeCol("playbooks", items);
    res.json(items[idx]);
  }));

  app.delete("/api/playbooks/:id", wrap(async (req, res) => {
    const items = await readCol("playbooks");
    const idx = items.findIndex((x) => String(x.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ message: "playbook no encontrado" });
    const [removed] = items.splice(idx, 1);
    await writeCol("playbooks", items);
    res.json(removed);
  }));

  // ── Sync desde Odoo ───────────────────────────────────────
  // POST /api/playbooks/:id/sync — trae ventas Odoo, recalcula
  // snapshot diario y KPIs, persiste todo en `kv`.

  app.post("/api/playbooks/:id/sync", wrap(async (req, res) => {
    const items = await readCol("playbooks");
    const pb = items.find((x) => String(x.id) === String(req.params.id));
    if (!pb) return res.status(404).json({ ok: false, error: "playbook no encontrado" });

    const t0 = Date.now();
    try {
      const { lines, meta } = await fetchOdooPlaybookSales(pb);
      const salesPayload = { lines, meta, syncedAt: nowIso() };
      const daily = buildDailySnapshot(pb, lines);
      const kpis = buildKpis(pb, lines);
      const leaderboard = buildLeaderboard(lines);
      const skuCoverage = buildSkuCoverage(pb, lines);

      const snapshot = {
        playbookId: pb.id,
        kpis,
        daily,
        leaderboard,
        skuCoverage,
        meta,
        syncedAt: nowIso(),
        elapsedMs: Date.now() - t0,
      };

      // Persistir en kv (usando el patrón del backend: un blob por playbook)
      await pool.query(
        `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [`playbook-sales:${pb.id}`, JSON.stringify(salesPayload), Date.now()]
      );
      await pool.query(
        `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [`playbook-daily-snapshot:${pb.id}`, JSON.stringify(snapshot), Date.now()]
      );

      res.json({
        ok: true,
        playbookId: pb.id,
        lineCount: lines.length,
        ...meta,
        kpis: {
          unitsSold: kpis.unitsSold,
          valueUsd: kpis.valueUsd,
          pctAttained: kpis.pctAttained,
          paceGapUnits: kpis.paceGapUnits,
        },
        elapsedMs: Date.now() - t0,
      });
    } catch (e) {
      console.error("[playbooks:sync]", e);
      res.status(500).json({ ok: false, error: e.message, playbookId: pb.id });
    }
  }));

  // ── Lectura de snapshot ya calculado (sin tocar Odoo) ─────
  app.get("/api/playbooks/:id/snapshot", wrap(async (req, res) => {
    const r = await pool.query("SELECT value, updated_at FROM kv WHERE key = $1",
      [`playbook-daily-snapshot:${req.params.id}`]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "snapshot no disponible; ejecute POST /sync" });
    res.json({ ok: true, snapshot: r.rows[0].value, updatedAt: r.rows[0].updated_at });
  }));

  // KPIs solamente (payload liviano para dashboard)
  app.get("/api/playbooks/:id/kpis", wrap(async (req, res) => {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1",
      [`playbook-daily-snapshot:${req.params.id}`]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "snapshot no disponible" });
    res.json({ ok: true, kpis: r.rows[0].value?.kpis || null });
  }));

  // Serie diaria (para gráfico)
  app.get("/api/playbooks/:id/daily", wrap(async (req, res) => {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1",
      [`playbook-daily-snapshot:${req.params.id}`]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "snapshot no disponible" });
    res.json({ ok: true, daily: r.rows[0].value?.daily || [] });
  }));

  // Ranking de vendedores
  app.get("/api/playbooks/:id/leaderboard", wrap(async (req, res) => {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1",
      [`playbook-daily-snapshot:${req.params.id}`]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "snapshot no disponible" });
    res.json({ ok: true, leaderboard: r.rows[0].value?.leaderboard || [] });
  }));

  // Cobertura de SKUs
  app.get("/api/playbooks/:id/sku-coverage", wrap(async (req, res) => {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1",
      [`playbook-daily-snapshot:${req.params.id}`]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "snapshot no disponible" });
    res.json({ ok: true, skuCoverage: r.rows[0].value?.skuCoverage || [] });
  }));

  // ── Cálculo de comisiones por mes ─────────────────────────
  // GET /api/playbooks/:id/commissions?month=2026-08
  app.get("/api/playbooks/:id/commissions", wrap(async (req, res) => {
    const items = await readCol("playbooks");
    const pb = items.find((x) => String(x.id) === String(req.params.id));
    if (!pb) return res.status(404).json({ ok: false, error: "playbook no encontrado" });
    const month = req.query.month || monthOf(new Date().toISOString());

    // Usar ventas ya sincronizadas si están; si no, error explícito
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [`playbook-sales:${pb.id}`]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "ventas no sincronizadas; ejecute POST /sync" });
    const lines = r.rows[0].value?.lines || [];

    const commissions = computeCommissions(pb, lines, month);
    // Persistir cierre
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [`playbook-commissions:${pb.id}:${month}`, JSON.stringify(commissions), Date.now()]
    );
    res.json({ ok: true, playbookId: pb.id, commissions });
  }));

  // Sync masivo (útil para cron)
  // POST /api/playbooks/sync-all → itera playbooks activos
  app.post("/api/playbooks/sync-all", wrap(async (_req, res) => {
    const items = await readCol("playbooks");
    const activos = items.filter((p) => p.status === "activo");
    const results = [];
    for (const pb of activos) {
      const t0 = Date.now();
      try {
        const { lines, meta } = await fetchOdooPlaybookSales(pb);
        const daily = buildDailySnapshot(pb, lines);
        const kpis = buildKpis(pb, lines);
        const leaderboard = buildLeaderboard(lines);
        const skuCoverage = buildSkuCoverage(pb, lines);
        const snapshot = {
          playbookId: pb.id, kpis, daily, leaderboard, skuCoverage, meta,
          syncedAt: nowIso(), elapsedMs: Date.now() - t0,
        };
        await pool.query(
          `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [`playbook-sales:${pb.id}`, JSON.stringify({ lines, meta, syncedAt: nowIso() }), Date.now()]
        );
        await pool.query(
          `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [`playbook-daily-snapshot:${pb.id}`, JSON.stringify(snapshot), Date.now()]
        );
        results.push({
          playbookId: pb.id, ok: true, lineCount: lines.length,
          unitsSold: kpis.unitsSold, pctAttained: kpis.pctAttained,
          elapsedMs: Date.now() - t0,
        });
      } catch (e) {
        results.push({ playbookId: pb.id, ok: false, error: e.message });
      }
    }
    res.json({ ok: true, count: results.length, results });
  }));

  console.log("[playbooks] routes registered");
}

// Exportar helpers para testing/debug
export const _internal = {
  SEED_PLAYBOOKS,
  PILOT_COMMISSIONS,
  buildKpis,
  buildDailySnapshot,
  buildLeaderboard,
  buildSkuCoverage,
  computeCommissions,
  expectedPace,
  coordinatorPct,
  bonusTier,
};
