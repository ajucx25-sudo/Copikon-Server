// playbooks.js — Módulo Playbooks Comerciales
// Seguimiento de campañas de venta con KPIs sincronizados desde Odoo
// Persistencia vía tabla kv (mismo patrón que el resto del server)

import * as odoo from "./odoo-client.js";

// ─── Helpers de persistencia sobre tabla kv ────────────────────────────
async function kvGet(pool, key, fallback) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
async function kvSet(pool, key, value) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value ?? null), Date.now()]
  );
}
async function kvDel(pool, key) {
  await pool.query("DELETE FROM kv WHERE key = $1", [key]);
}

const K_PLAYBOOKS = "playbooks"; // array con la config de cada playbook
const K_SNAPSHOT = (id) => `playbook-daily-snapshot:${id}`;

// ─── Config default de comisiones (Piloto Stanley 40oz — 7 bodegas primarias) ─
// Basado en PDF "Playbook Comercial Stanley 40oz - Grupo Copikon" (pág. 13-16).
// Cuando se replique a otras campañas o unidades se editará por playbook.
const DEFAULT_COMMISSION_CONFIG = {
  salesperson: {
    basePct: 0.015,             // 1.5% sobre cobranza personal
    overstockMultiplier: 1.5,   // ×1.5 → 2.25% en SKU sobrestock (SUSTITUYE base, no suma)
    deadSkuMultiplier: 2.0,     // ×2.0 → 3.0% en SKU muerto (SUSTITUYE base, no suma)
    perUnitBonusMayor: 2.0,             // +$2/uds venta B2B ≥50 uds a un mismo cliente
    perUnitBonusPersonalizacion: 3.0,   // +$3/uds venta corp. con grabado ≥50 uds
    referralBonusPerClient: 50,         // $50 fijo por primer pedido de mayorista nuevo ≥50 uds
  },
  coordManager: {
    // banda plana por tramo sobre cobranza total tienda; cada uno (gte y coord) cobra completa
    bands: [
      { min: 0,      max: 25000,  pct: 0      },
      { min: 25001,  max: 50000,  pct: 0.0020 },
      { min: 50001,  max: 100000, pct: 0.0035 },
      { min: 100001, max: null,   pct: 0.0050 },
    ],
  },
  monthlyBonus: {
    // Bono meta Stanley — se mide contra bonusTargetUnits (piloto: 350 uds).
    // La meta operativa 2,779 uds vive en playbook.targetUnits; el bono se mide aparte.
    bonusTargetUnits: 350,
    bonusMonthlyTargets: [
      { month: 1, units: 90 },
      { month: 2, units: 120 },
      { month: 3, units: 140 },
    ],
    tiers: [
      { minPct: 0,    maxPct: 0.6999, label: "— (sin bono)", poolUsd: 0,   gerenteUsd: 0,   coordUsd: 0,   vendPoolUsd: 0   },
      { minPct: 0.70, maxPct: 0.99,   label: "Base",         poolUsd: 50,  gerenteUsd: 15,  coordUsd: 15,  vendPoolUsd: 20  },
      { minPct: 1.00, maxPct: 1.29,   label: "Meta",         poolUsd: 130, gerenteUsd: 40,  coordUsd: 40,  vendPoolUsd: 50  },
      { minPct: 1.30, maxPct: 1.59,   label: "Sobre-meta",   poolUsd: 230, gerenteUsd: 70,  coordUsd: 70,  vendPoolUsd: 90  },
      { minPct: 1.60, maxPct: null,   label: "Excelencia",   poolUsd: 330, gerenteUsd: 100, coordUsd: 100, vendPoolUsd: 130 },
    ],
  },
};

// ─── Playbooks precargados ──────────────────────────────────────────────
const SEED_PLAYBOOKS = [
  {
    id: "stanley-40oz-bto-2026q3",
    name: "Stanley 40oz — Piloto Barquisimeto",
    unit: "generators", // unidad de negocio
    warehouseCode: "BTO",
    campaignTag: "STANLEY40-2026Q3",
    windowStart: "2026-08-04",
    windowEnd: "2026-11-01",
    targetUnits: 1900,
    monthlyTargets: [
      { month: "2026-08", units: 500 },
      { month: "2026-09", units: 650 },
      { month: "2026-10", units: 750 },
    ],
    skus: [
      { code: "STAN40-BLK", label: "Stanley 40oz Negro", overstock: false },
      { code: "STAN40-CHR", label: "Stanley 40oz Charcoal", overstock: false },
      { code: "STAN40-RSE", label: "Stanley 40oz Rose Quartz", overstock: true },
      { code: "STAN40-CRM", label: "Stanley 40oz Cream", overstock: false },
    ],
    prices: {
      costUsd: 18.5,
      pvpDetalUsd: 32.9,
      pvpMayorUsd: 27.5,
      pvpInstitucionalUsd: 24.9,
    },
    commissions: DEFAULT_COMMISSION_CONFIG,
    status: "active",
    createdAt: "2026-08-04T00:00:00.000Z",
  },
  {
    id: "conos-traffcone-bto-2026q3",
    name: "Conos TRAFFCONE — Piloto Barquisimeto",
    unit: "generators",
    warehouseCode: "BTO",
    campaignTag: "TRAFFCONE-2026Q3",
    windowStart: "2026-08-04",
    windowEnd: "2026-11-01",
    targetUnits: 1900,
    monthlyTargets: [
      { month: "2026-08", units: 500 },
      { month: "2026-09", units: 650 },
      { month: "2026-10", units: 750 },
    ],
    skus: [
      { code: "TRAFFCONE-28", label: "Cono TRAFFCONE 28\"", overstock: false },
      { code: "TRAFFCONE-36", label: "Cono TRAFFCONE 36\"", overstock: true },
      { code: "TRAFFCONE-18", label: "Cono TRAFFCONE 18\"", overstock: false },
      { code: "TRAFFCONE-BASE", label: "Base contrapeso TRAFFCONE", overstock: false },
    ],
    prices: {
      costUsd: 8.9,
      pvpDetalUsd: 18.5,
      pvpMayorUsd: 15.9,
      pvpInstitucionalUsd: 13.5,
    },
    commissions: DEFAULT_COMMISSION_CONFIG,
    status: "active",
    createdAt: "2026-08-04T00:00:00.000Z",
  },
];

async function ensureSeed(pool) {
  const existing = await kvGet(pool, K_PLAYBOOKS, null);
  if (!Array.isArray(existing) || existing.length === 0) {
    await kvSet(pool, K_PLAYBOOKS, SEED_PLAYBOOKS);
    return SEED_PLAYBOOKS;
  }
  return existing;
}

// ─── Cálculo de KPIs a partir de líneas de venta ────────────────────────
function computeKpis(playbook, orderLines, now = new Date()) {
  const ws = new Date(playbook.windowStart);
  const we = new Date(playbook.windowEnd);
  const totalDays = Math.max(1, Math.round((we - ws) / 86400000));
  const daysElapsed = Math.max(0, Math.min(totalDays, Math.round((now - ws) / 86400000)));

  let unitsSold = 0;
  let valueUsd = 0;
  const skusActiveSet = new Set();
  const salespeopleSet = new Set();
  const ordersSet = new Set();

  for (const l of orderLines) {
    unitsSold += Number(l.units || 0);
    valueUsd += Number(l.valueUsd || 0);
    if (l.sku) skusActiveSet.add(l.sku);
    if (l.salespersonId) salespeopleSet.add(l.salespersonId);
    if (l.orderId) ordersSet.add(l.orderId);
  }

  const targetUnits = Number(playbook.targetUnits || 0) || 1;
  const pctAttained = unitsSold / targetUnits;
  const expectedUnitsToDate = Math.round((targetUnits * daysElapsed) / totalDays);
  const paceGapUnits = unitsSold - expectedUnitsToDate;
  const paceGapPct = expectedUnitsToDate > 0 ? paceGapUnits / expectedUnitsToDate : 0;

  return {
    updatedAt: now.toISOString(),
    windowStart: playbook.windowStart,
    windowEnd: playbook.windowEnd,
    targetUnits,
    unitsSold,
    valueUsd: Math.round(valueUsd * 100) / 100,
    pctAttained: Math.round(pctAttained * 10000) / 10000,
    expectedUnitsToDate,
    paceGapUnits,
    paceGapPct: Math.round(paceGapPct * 10000) / 10000,
    skusActive: skusActiveSet.size,
    skusTotal: (playbook.skus || []).length,
    salespeopleActive: salespeopleSet.size,
    ordersCount: ordersSet.size,
  };
}

function computeDaily(playbook, orderLines) {
  const byDate = new Map();
  for (const l of orderLines) {
    const d = (l.date || "").slice(0, 10);
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, { date: d, units: 0, valueUsd: 0, orders: new Set() });
    const b = byDate.get(d);
    b.units += Number(l.units || 0);
    b.valueUsd += Number(l.valueUsd || 0);
    if (l.orderId) b.orders.add(l.orderId);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  let cumUnits = 0;
  let cumValueUsd = 0;
  return rows.map((r) => {
    cumUnits += r.units;
    cumValueUsd += r.valueUsd;
    return {
      date: r.date,
      units: r.units,
      valueUsd: Math.round(r.valueUsd * 100) / 100,
      orders: r.orders.size,
      cumUnits,
      cumValueUsd: Math.round(cumValueUsd * 100) / 100,
    };
  });
}

function computeLeaderboard(playbook, orderLines) {
  const byPerson = new Map();
  for (const l of orderLines) {
    const id = l.salespersonId || 0;
    const name = l.salespersonName || "Sin asignar";
    if (!byPerson.has(id)) {
      byPerson.set(id, {
        salespersonId: id,
        salespersonName: name,
        units: 0,
        valueUsd: 0,
        orders: new Set(),
        skus: new Set(),
      });
    }
    const p = byPerson.get(id);
    p.units += Number(l.units || 0);
    p.valueUsd += Number(l.valueUsd || 0);
    if (l.orderId) p.orders.add(l.orderId);
    if (l.sku) p.skus.add(l.sku);
  }
  return [...byPerson.values()]
    .map((p) => ({
      salespersonId: p.salespersonId,
      salespersonName: p.salespersonName,
      units: p.units,
      valueUsd: Math.round(p.valueUsd * 100) / 100,
      orders: p.orders.size,
      skusCovered: p.skus.size,
    }))
    .sort((a, b) => b.units - a.units);
}

function computeSkuCoverage(playbook, orderLines) {
  const bySku = new Map();
  const totalValue = orderLines.reduce((s, l) => s + Number(l.valueUsd || 0), 0) || 1;

  // Sembrar todos los SKUs del playbook (incluyendo sin ventas)
  for (const s of playbook.skus || []) {
    bySku.set(s.code, {
      sku: s.code,
      label: s.label,
      units: 0,
      valueUsd: 0,
      overstock: !!s.overstock,
    });
  }
  for (const l of orderLines) {
    if (!l.sku) continue;
    if (!bySku.has(l.sku)) {
      bySku.set(l.sku, { sku: l.sku, label: l.sku, units: 0, valueUsd: 0, overstock: false });
    }
    const s = bySku.get(l.sku);
    s.units += Number(l.units || 0);
    s.valueUsd += Number(l.valueUsd || 0);
  }
  return [...bySku.values()]
    .map((s) => ({
      ...s,
      valueUsd: Math.round(s.valueUsd * 100) / 100,
      pctOfTotal: Math.round((s.valueUsd / totalValue) * 10000) / 100, // %
    }))
    .sort((a, b) => b.units - a.units);
}

// ─── Cálculo de comisiones mensuales ────────────────────────────────────
function computeMonthlyCommissions(playbook, orderLines, month /* YYYY-MM */) {
  const cfg = playbook.commissions || DEFAULT_COMMISSION_CONFIG;
  const linesInMonth = orderLines.filter((l) => (l.date || "").slice(0, 7) === month);
  const overstockSet = new Set((playbook.skus || []).filter((s) => s.overstock).map((s) => s.code));
  const deadSkuSet   = new Set((playbook.skus || []).filter((s) => s.deadSku  ).map((s) => s.code));

  // Totales
  let totalValueUsd = 0;
  let totalUnits = 0;
  const byPerson = new Map();
  for (const l of linesInMonth) {
    const value = Number(l.valueUsd || 0);
    const units = Number(l.units || 0);
    totalValueUsd += value;
    totalUnits += units;

    const id = l.salespersonId || 0;
    const name = l.salespersonName || "Sin asignar";
    if (!byPerson.has(id)) {
      byPerson.set(id, {
        salespersonId: id,
        salespersonName: name,
        valueUsd: 0,
        valueUsdBase: 0,          // porción a tasa base 1.5%
        valueUsdOverstock: 0,     // porción a 2.25%
        valueUsdDead: 0,          // porción a 3.0%
        units: 0,
        unitsMayor: 0,
        unitsPersonalizacion: 0,
        unitsOverstock: 0,
        unitsDead: 0,
        referrals: 0,
      });
    }
    const p = byPerson.get(id);
    p.valueUsd += value;
    p.units += units;
    // Bucketing por tipo de SKU — muerto y sobrestock SUSTITUYEN la tasa base
    if (deadSkuSet.has(l.sku)) {
      p.valueUsdDead += value;
      p.unitsDead += units;
    } else if (overstockSet.has(l.sku)) {
      p.valueUsdOverstock += value;
      p.unitsOverstock += units;
    } else {
      p.valueUsdBase += value;
    }
    if (l.priceBand === "mayor") p.unitsMayor += units;
    if (l.personalizacionCorp) p.unitsPersonalizacion += units;
    if (l.newReferralClient) p.referrals += 1;
  }

  // Meta del mes (operativa — la del playbook.monthlyTargets)
  const monthTarget =
    (playbook.monthlyTargets || []).find((m) => m.month === month)?.units ||
    Math.round((playbook.targetUnits || 0) / Math.max(1, (playbook.monthlyTargets || []).length));
  const pctVsMonthTarget = monthTarget > 0 ? totalUnits / monthTarget : 0;

  // Meta bono Stanley (aparte de la operativa: piloto 350 uds → 90/120/140)
  // Se busca por índice del mes dentro de playbook.monthlyTargets
  const monthIdx = (playbook.monthlyTargets || []).findIndex((m) => m.month === month);
  const bonusMonthlyTargets = cfg.monthlyBonus?.bonusMonthlyTargets || [];
  const bonusMonthTarget =
    bonusMonthlyTargets.find((t) => (t.month - 1) === monthIdx)?.units ||
    Math.round((cfg.monthlyBonus?.bonusTargetUnits || 0) / Math.max(1, bonusMonthlyTargets.length || 1));
  const pctVsBonusTarget = bonusMonthTarget > 0 ? totalUnits / bonusMonthTarget : 0;

  // Comisión de vendedores (tasas SUSTITUYENTES por bucket)
  const basePct = cfg.salesperson?.basePct || 0;
  const overPct = basePct * (cfg.salesperson?.overstockMultiplier || 1);
  const deadPct = basePct * (cfg.salesperson?.deadSkuMultiplier   || 1);
  const salespeople = [...byPerson.values()].map((p) => {
    const baseCommission      = p.valueUsdBase      * basePct;
    const overstockCommission = p.valueUsdOverstock * overPct;
    const deadCommission      = p.valueUsdDead      * deadPct;
    const bonusMayor          = p.unitsMayor           * (cfg.salesperson?.perUnitBonusMayor          || 0);
    const bonusPersonalizacion= p.unitsPersonalizacion * (cfg.salesperson?.perUnitBonusPersonalizacion || 0);
    const bonusReferral       = p.referrals            * (cfg.salesperson?.referralBonusPerClient     || 0);
    const totalCommission =
      baseCommission + overstockCommission + deadCommission +
      bonusMayor + bonusPersonalizacion + bonusReferral;
    return {
      ...p,
      valueUsd:              Math.round(p.valueUsd              * 100) / 100,
      valueUsdBase:          Math.round(p.valueUsdBase          * 100) / 100,
      valueUsdOverstock:     Math.round(p.valueUsdOverstock     * 100) / 100,
      valueUsdDead:          Math.round(p.valueUsdDead          * 100) / 100,
      baseCommission:        Math.round(baseCommission          * 100) / 100,
      overstockCommission:   Math.round(overstockCommission     * 100) / 100,
      deadCommission:        Math.round(deadCommission          * 100) / 100,
      bonusMayor:            Math.round(bonusMayor              * 100) / 100,
      bonusPersonalizacion:  Math.round(bonusPersonalizacion    * 100) / 100,
      bonusReferral:         Math.round(bonusReferral           * 100) / 100,
      totalCommission:       Math.round(totalCommission         * 100) / 100,
    };
  });

  // Comisión coord/gerente (banda plana sobre cobranza total tienda)
  const bands = cfg.coordManager?.bands || DEFAULT_COMMISSION_CONFIG.coordManager.bands;
  const activeBand =
    bands.find(
      (b) =>
        totalValueUsd >= (b.min || 0) &&
        (b.max === null || b.max === undefined || totalValueUsd <= b.max)
    ) || bands[0];
  const coordManagerCommission = totalValueUsd * (activeBand.pct || 0);

  // Bono meta Stanley (medido contra bonusMonthTarget, no contra monthTarget operativa)
  const tiers = cfg.monthlyBonus?.tiers || DEFAULT_COMMISSION_CONFIG.monthlyBonus.tiers;
  const activeTier =
    tiers.find(
      (t) =>
        pctVsBonusTarget >= (t.minPct || 0) &&
        (t.maxPct === null || t.maxPct === undefined || pctVsBonusTarget <= t.maxPct)
    ) || tiers[0] || null;

  const gerenteBonus = activeTier ? (activeTier.gerenteUsd || 0) : 0;
  const coordBonus   = activeTier ? (activeTier.coordUsd   || 0) : 0;
  const vendPool     = activeTier ? (activeTier.vendPoolUsd || 0) : 0;

  // Reparto del pool de vendedores proporcional a uds vendidas ese mes por cada vendedor activo
  const activeSellers = salespeople.filter((s) => s.units > 0);
  const totalUnitsActive = activeSellers.reduce((s, p) => s + p.units, 0);
  const salespeopleWithBonus = salespeople.map((s) => {
    const share = totalUnitsActive > 0 && s.units > 0 ? s.units / totalUnitsActive : 0;
    const bonusStanley = Math.round(vendPool * share * 100) / 100;
    return {
      ...s,
      bonusStanley,
      totalWithBonus: Math.round((s.totalCommission + bonusStanley) * 100) / 100,
    };
  });

  const totalSalesCommissions = salespeopleWithBonus.reduce((s, p) => s + p.totalWithBonus, 0);
  const totalPayout =
    totalSalesCommissions +
    coordManagerCommission * 2 +
    gerenteBonus + coordBonus;

  return {
    month,
    totalUnits,
    totalValueUsd: Math.round(totalValueUsd * 100) / 100,
    monthTarget,
    pctVsMonthTarget: Math.round(pctVsMonthTarget * 10000) / 10000,
    bonusMonthTarget,
    pctVsBonusTarget: Math.round(pctVsBonusTarget * 10000) / 10000,
    salespeople: salespeopleWithBonus,
    coordManager: {
      activeBand: activeBand
        ? { min: activeBand.min, max: activeBand.max, pct: activeBand.pct }
        : null,
      commissionPerPerson: Math.round(coordManagerCommission * 100) / 100,
      commissionBoth:      Math.round(coordManagerCommission * 2 * 100) / 100,
    },
    monthlyBonus: activeTier
      ? {
          tier:           activeTier.label,
          gerenteUsd:     gerenteBonus,
          coordUsd:       coordBonus,
          vendPoolUsd:    vendPool,
          poolTotalUsd:   activeTier.poolUsd || (gerenteBonus + coordBonus + vendPool),
        }
      : { tier: "Sin bono", gerenteUsd: 0, coordUsd: 0, vendPoolUsd: 0, poolTotalUsd: 0 },
    totalPayout: Math.round(totalPayout * 100) / 100,
  };
}

// ─── Sync desde Odoo ────────────────────────────────────────────────────
// Busca sale.order.line en Odoo cuyos productos coincidan con los SKUs del playbook,
// dentro de la ventana temporal y (opcional) del warehouse configurado.
async function syncPlaybookFromOdoo(pool, playbook) {
  const skuCodes = (playbook.skus || []).map((s) => s.code).filter(Boolean);
  if (skuCodes.length === 0) {
    return { linesSynced: 0, reason: "no-skus-configured" };
  }

  // 1) Resolver product.product IDs a partir de default_code (SKU)
  const products = await odoo.searchRead(
    "product.product",
    [["default_code", "in", skuCodes]],
    ["id", "default_code", "name"],
    { limit: 500 }
  );
  const productIds = products.map((p) => p.id);
  const skuById = new Map(products.map((p) => [p.id, p.default_code || p.name]));

  if (productIds.length === 0) {
    // Sin productos en Odoo → guardar vacío pero registrar intento
    await kvSet(pool, K_SNAPSHOT(playbook.id), {
      playbookId: playbook.id,
      lines: [],
      syncedAt: new Date().toISOString(),
      productsMatched: 0,
    });
    return { linesSynced: 0, productsMatched: 0, reason: "no-odoo-products-match" };
  }

  // 2) Buscar sale.order.line dentro de la ventana temporal
  const domain = [
    ["product_id", "in", productIds],
    ["order_id.date_order", ">=", `${playbook.windowStart} 00:00:00`],
    ["order_id.date_order", "<=", `${playbook.windowEnd} 23:59:59`],
    ["order_id.state", "in", ["sale", "done"]],
  ];
  // Multi-almacén: warehouseCodes[] tiene prioridad; warehouseCode (legacy) se usa como fallback.
  const whCodes = Array.isArray(playbook.warehouseCodes) && playbook.warehouseCodes.length > 0
    ? playbook.warehouseCodes.map((c) => String(c).toUpperCase().trim()).filter(Boolean)
    : (playbook.warehouseCode ? [String(playbook.warehouseCode).toUpperCase().trim()] : []);

  if (whCodes.length === 1) {
    domain.push(["order_id.warehouse_id.code", "=", whCodes[0]]);
  } else if (whCodes.length > 1) {
    domain.push(["order_id.warehouse_id.code", "in", whCodes]);
  }

  let saleLines = [];
  try {
    saleLines = await odoo.searchRead(
      "sale.order.line",
      domain,
      [
        "id",
        "order_id",
        "product_id",
        "product_uom_qty",
        "price_subtotal",
        "price_unit",
      ],
      { limit: 5000 }
    );
  } catch (e) {
    // Fallback: sin filtro por warehouse.code (algunos ODOO no exponen ese path directo)
    if (whCodes.length > 0) {
      const d2 = domain.filter((c) => c[0] !== "order_id.warehouse_id.code");
      saleLines = await odoo.searchRead("sale.order.line", d2, [
        "id",
        "order_id",
        "product_id",
        "product_uom_qty",
        "price_subtotal",
        "price_unit",
      ], { limit: 5000 });
    } else {
      throw e;
    }
  }

  // 3) Leer las cabeceras de sale.order para obtener fecha, vendedor y warehouse
  const orderIds = [...new Set(saleLines.map((l) => (Array.isArray(l.order_id) ? l.order_id[0] : l.order_id)))];
  const orders =
    orderIds.length > 0
      ? await odoo.searchRead(
          "sale.order",
          [["id", "in", orderIds]],
          ["id", "name", "date_order", "user_id", "warehouse_id", "partner_id"],
          { limit: 5000 }
        )
      : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // 4) Filtrar por warehouse si aplica (post-filter para seguridad — cuando el path warehouse_id.code no fue aplicable)
  const lines = [];
  for (const l of saleLines) {
    const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
    const o = orderById.get(oid);
    if (!o) continue;
    if (whCodes.length > 0) {
      const whName = Array.isArray(o.warehouse_id) ? (o.warehouse_id[1] || "").toUpperCase() : "";
      // El name del warehouse debe contener alguno de los códigos configurados
      const matches = whCodes.some((wc) => whName.includes(wc));
      if (!matches) continue;
    }

    const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
    const sku = skuById.get(pid) || "";
    const salespersonId = Array.isArray(o.user_id) ? o.user_id[0] : 0;
    const salespersonName = Array.isArray(o.user_id) ? o.user_id[1] : "Sin asignar";
    const price = Number(l.price_unit || 0);
    const units = Number(l.product_uom_qty || 0);

    // Inferir priceBand por comparación. Prioridad:
    //  1) pricing por SKU (skuPricing + mayorTiers) si está definido en el playbook
    //  2) fallback: pricing genérico del playbook (detal/mayor/institucional)
    let priceBand = "detal";
    const skuDef = (playbook.skus || []).find((s) => (s.code || "").toUpperCase() === (sku || "").toUpperCase());
    if (skuDef && (skuDef.detalUsd || skuDef.mayorTiers)) {
      // Buscar el tier más cercano por precio unitario
      const options = [];
      if (skuDef.detalUsd) options.push({ band: "detal", price: Number(skuDef.detalUsd) });
      if (Array.isArray(skuDef.mayorTiers)) {
        for (const t of skuDef.mayorTiers) {
          const tierBand = `mayor-${t.fromQty || 0}`;
          options.push({ band: tierBand, price: Number(t.price) });
        }
      }
      if (options.length > 0) {
        let best = options[0];
        let bestDelta = Math.abs(price - best.price);
        for (const o2 of options.slice(1)) {
          const d = Math.abs(price - o2.price);
          if (d < bestDelta) { best = o2; bestDelta = d; }
        }
        priceBand = best.band;
      }
    } else if (playbook.prices) {
      const dDetal = Math.abs(price - (playbook.prices.pvpDetalUsd || 0));
      const dMayor = Math.abs(price - (playbook.prices.pvpMayorUsd || 0));
      const dInst = Math.abs(price - (playbook.prices.pvpInstitucionalUsd || 0));
      const min = Math.min(dDetal, dMayor, dInst);
      if (min === dMayor) priceBand = "mayor";
      else if (min === dInst) priceBand = "institucional";
    }

    // Normalizar: cualquier banda "mayor-*" cuenta como "mayor" para cálculo de comisión legacy
    const priceBandGroup = priceBand.startsWith("mayor") ? "mayor" : priceBand;

    lines.push({
      lineId: l.id,
      orderId: oid,
      orderName: o.name,
      date: (o.date_order || "").slice(0, 10),
      sku,
      units,
      priceUnit: price,
      valueUsd: Number(l.price_subtotal || 0),
      salespersonId,
      salespersonName,
      warehouse: Array.isArray(o.warehouse_id) ? o.warehouse_id[1] : "",
      priceBand,       // detal | mayor-20 | mayor-50 | mayor-100 | mayor-250 | institucional
      priceBandGroup,  // detal | mayor | institucional (para cálculo comisión legacy)
      newReferralClient: false, // marca manual futura
    });
  }

  const snapshot = {
    playbookId: playbook.id,
    lines,
    syncedAt: new Date().toISOString(),
    productsMatched: productIds.length,
  };
  await kvSet(pool, K_SNAPSHOT(playbook.id), snapshot);

  return { linesSynced: lines.length, productsMatched: productIds.length };
}

// ─── Rutas Express ──────────────────────────────────────────────────────
function registerPlaybooksRoutes(app, pool, wrap) {
  // Asegurar seed en el primer request
  let seeded = false;
  const ensure = async () => {
    if (!seeded) {
      await ensureSeed(pool);
      seeded = true;
    }
  };

  app.get("/api/playbooks", wrap(async (_req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    // Enriquecer cada playbook con KPIs cacheados
    const enriched = await Promise.all(list.map(async (p) => {
      const snap = await kvGet(pool, K_SNAPSHOT(p.id), null);
      const lines = snap?.lines || [];
      const kpis = computeKpis(p, lines);
      return {
        id: p.id,
        name: p.name,
        unit: p.unit,
        warehouseCode: p.warehouseCode,
        warehouseCodes: Array.isArray(p.warehouseCodes) ? p.warehouseCodes : (p.warehouseCode ? [p.warehouseCode] : []),
        windowStart: p.windowStart,
        windowEnd: p.windowEnd,
        targetUnits: p.targetUnits,
        status: p.status,
        kpis,
        syncedAt: snap?.syncedAt || null,
      };
    }));
    res.json({ ok: true, playbooks: enriched });
  }));

  app.get("/api/playbooks/:id", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    res.json({ ok: true, playbook: p });
  }));

  app.post("/api/playbooks", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const body = req.body || {};
    if (!body.id || !body.name) {
      return res.status(400).json({ ok: false, error: "id-and-name-required" });
    }
    if (list.find((x) => x.id === body.id)) {
      return res.status(409).json({ ok: false, error: "id-already-exists" });
    }
    const now = new Date().toISOString();
    const playbook = {
      id: body.id,
      name: body.name,
      unit: body.unit || "generators",
      warehouseCode: body.warehouseCode || "",
      warehouseCodes: Array.isArray(body.warehouseCodes) ? body.warehouseCodes.filter(Boolean) : [],
      campaignTag: body.campaignTag || "",
      windowStart: body.windowStart || now.slice(0, 10),
      windowEnd: body.windowEnd || now.slice(0, 10),
      targetUnits: Number(body.targetUnits || 0),
      monthlyTargets: Array.isArray(body.monthlyTargets) ? body.monthlyTargets : [],
      skus: Array.isArray(body.skus) ? body.skus : [],
      prices: body.prices || {
        costUsd: 0, pvpDetalUsd: 0, pvpMayorUsd: 0, pvpInstitucionalUsd: 0,
      },
      commissions: body.commissions || DEFAULT_COMMISSION_CONFIG,
      status: body.status || "active",
      createdAt: now,
    };
    list.push(playbook);
    await kvSet(pool, K_PLAYBOOKS, list);
    res.json({ ok: true, playbook });
  }));

  app.patch("/api/playbooks/:id", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "not-found" });
    const patch = req.body || {};
    // No permitir cambiar el id
    delete patch.id;
    list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
    await kvSet(pool, K_PLAYBOOKS, list);
    res.json({ ok: true, playbook: list[idx] });
  }));

  app.delete("/api/playbooks/:id", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "not-found" });
    list.splice(idx, 1);
    await kvSet(pool, K_PLAYBOOKS, list);
    await kvDel(pool, K_SNAPSHOT(req.params.id));
    res.json({ ok: true });
  }));

  app.post("/api/playbooks/:id/sync", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    try {
      const result = await syncPlaybookFromOdoo(pool, p);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }));

  app.post("/api/playbooks/sync-all", wrap(async (_req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const results = [];
    for (const p of list) {
      if (p.status !== "active") continue;
      try {
        const r = await syncPlaybookFromOdoo(pool, p);
        results.push({ id: p.id, ok: true, ...r });
      } catch (e) {
        results.push({ id: p.id, ok: false, error: e.message || String(e) });
      }
    }
    res.json({ ok: true, results });
  }));

  // DEBUG: inspecciona qué órdenes hay en Odoo para los SKUs del playbook en un rango de fechas
  // Muestra TODOS los estados (draft, sent, sale, done, cancel) para diagnosticar por qué no aparecen ventas
  app.get("/api/playbooks/:id/debug-odoo", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const skuCodes = (p.skus || []).map((s) => s.code).filter(Boolean);
    if (skuCodes.length === 0) return res.json({ ok: false, error: "no-skus" });
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    try {
      const products = await odoo.searchRead(
        "product.product",
        [["default_code", "in", skuCodes]],
        ["id", "default_code", "name"],
        { limit: 500 }
      );
      const productIds = products.map((pp) => pp.id);
      if (productIds.length === 0) return res.json({ ok: true, from, to, skuCodes, productsMatched: 0, lines: [], orders: [] });
      const lines = await odoo.searchRead(
        "sale.order.line",
        [
          ["product_id", "in", productIds],
          ["order_id.date_order", ">=", `${from} 00:00:00`],
          ["order_id.date_order", "<=", `${to} 23:59:59`],
        ],
        ["id", "order_id", "product_id", "product_uom_qty", "price_subtotal"],
        { limit: 500 }
      );
      const orderIds = [...new Set(lines.map((l) => (Array.isArray(l.order_id) ? l.order_id[0] : l.order_id)))];
      const orders = orderIds.length > 0
        ? await odoo.searchRead("sale.order", [["id", "in", orderIds]], ["id", "name", "date_order", "state", "user_id", "warehouse_id", "partner_id"], { limit: 500 })
        : [];
      const byState = {};
      for (const o of orders) byState[o.state] = (byState[o.state] || 0) + 1;
      res.json({ ok: true, from, to, skuCodes, productsMatched: productIds.length, lineCount: lines.length, orderCount: orders.length, byState, orders: orders.map((o) => ({ id: o.id, name: o.name, date: o.date_order, state: o.state, warehouse: Array.isArray(o.warehouse_id) ? o.warehouse_id[1] : "", salesperson: Array.isArray(o.user_id) ? o.user_id[1] : "", partner: Array.isArray(o.partner_id) ? o.partner_id[1] : "" })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }));

  app.get("/api/playbooks/:id/snapshot", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const snap = (await kvGet(pool, K_SNAPSHOT(p.id), null)) || { lines: [], syncedAt: null };
    const lines = snap.lines || [];
    const snapshot = {
      playbookId: p.id,
      syncedAt: snap.syncedAt,
      kpis: computeKpis(p, lines),
      daily: computeDaily(p, lines),
      leaderboard: computeLeaderboard(p, lines),
      skuCoverage: computeSkuCoverage(p, lines),
    };
    res.json({ ok: true, snapshot });
  }));

  app.get("/api/playbooks/:id/kpis", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const snap = (await kvGet(pool, K_SNAPSHOT(p.id), null)) || { lines: [] };
    res.json({ ok: true, kpis: computeKpis(p, snap.lines || []) });
  }));

  app.get("/api/playbooks/:id/daily", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const snap = (await kvGet(pool, K_SNAPSHOT(p.id), null)) || { lines: [] };
    res.json({ ok: true, daily: computeDaily(p, snap.lines || []) });
  }));

  app.get("/api/playbooks/:id/leaderboard", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const snap = (await kvGet(pool, K_SNAPSHOT(p.id), null)) || { lines: [] };
    res.json({ ok: true, leaderboard: computeLeaderboard(p, snap.lines || []) });
  }));

  app.get("/api/playbooks/:id/sku-coverage", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const snap = (await kvGet(pool, K_SNAPSHOT(p.id), null)) || { lines: [] };
    res.json({ ok: true, skuCoverage: computeSkuCoverage(p, snap.lines || []) });
  }));

  app.get("/api/playbooks/:id/commissions", wrap(async (req, res) => {
    await ensure();
    const list = (await kvGet(pool, K_PLAYBOOKS, [])) || [];
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    const snap = (await kvGet(pool, K_SNAPSHOT(p.id), null)) || { lines: [] };
    res.json({ ok: true, commissions: computeMonthlyCommissions(p, snap.lines || [], month) });
  }));
}

export { registerPlaybooksRoutes };
