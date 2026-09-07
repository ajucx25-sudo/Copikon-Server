// Módulo Listas de Precio B2B
// Almacena listas en kv:pricelistsB2B con reglas mixtas (categorías, marcas, SKUs manuales)
// + descuento por segmento + tiers por volumen (default global u override por SKU).
// Endpoints:
//   GET    /api/pricelists                       → lista todas
//   GET    /api/pricelists/:id                   → detalle
//   POST   /api/pricelists                       → crear
//   PATCH  /api/pricelists/:id                   → actualizar
//   DELETE /api/pricelists/:id                   → eliminar
//   POST   /api/pricelists/:id/materialize       → resuelve reglas y retorna lista SKU × precio × tiers
//   POST   /api/pricelists/:id/assign-clients    → asigna la lista a array de clientIds
//   GET    /api/pricelists/client/:clientId      → retorna lista asignada + materializada del cliente

const K = "pricelistsB2B";

async function readList(pool) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [K]);
  if (!r.rows[0]) return [];
  const v = r.rows[0].value;
  return Array.isArray(v) ? v : [];
}

async function writeList(pool, arr) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [K, JSON.stringify(arr ?? []), Date.now()]
  );
}

async function readProducts(pool) {
  const r = await pool.query("SELECT value FROM kv WHERE key = 'erpProducts'");
  if (!r.rows[0]) return [];
  const v = r.rows[0].value;
  return Array.isArray(v) ? v : [];
}

async function readClients(pool) {
  const r = await pool.query("SELECT value FROM kv WHERE key = 'erpClients'");
  if (!r.rows[0]) return [];
  const v = r.rows[0].value;
  return Array.isArray(v) ? v : [];
}

async function writeClients(pool, arr) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    ["erpClients", JSON.stringify(arr ?? []), Date.now()]
  );
}

/**
 * Shape de un pricelist:
 * {
 *   id: "pl-<ts>-<rand>",
 *   name: "Distribuidor Nacional 2026",
 *   segment: "distribuidor" | "mayorista_plata" | "mayorista_oro" | "corporativo" | "custom",
 *   segmentLabel: "Distribuidor Nacional",
 *   segmentDiscountPct: 10,        // -10% sobre precio base
 *   basedOnList: "salePrice",      // "salePrice" (lista Copikon 07/08) o "landedCost" o "minPrice"
 *   rules: {
 *     includeAll: false,           // si true, arranca con todo el catálogo
 *     categories: ["generadores","accesorios"],
 *     brands: ["baifa","stanley"],
 *     skus: ["FST40OZBCHROM"]      // SKUs manuales agregados
 *   },
 *   exclusions: {
 *     skus: ["SKUX"]
 *   },
 *   defaultTiers: [                // tiers por volumen aplicados a TODO SKU sin override
 *     { minQty: 1,   maxQty: 9,    additionalDiscountPct: 0 },
 *     { minQty: 10,  maxQty: 49,   additionalDiscountPct: 3 },
 *     { minQty: 50,  maxQty: null, additionalDiscountPct: 6 }
 *   ],
 *   skuOverrides: {
 *     "SKU1": {
 *       priceOverride: null,       // si != null, este precio reemplaza al calculado
 *       tiers: [                   // si != null, reemplaza defaultTiers para este SKU
 *         { minQty:1, maxQty:5, additionalDiscountPct:0 },
 *         { minQty:6, maxQty:null, additionalDiscountPct:5 }
 *       ]
 *     }
 *   },
 *   conditions: {
 *     paymentTerms: "50% anticipo, 50% contra entrega",
 *     validityDays: 15,
 *     deliveryTerms: "Puesto en almacén BTO. Flete corre por el cliente.",
 *     currency: "USD",
 *     notes: "Precios sujetos a cambio sin previo aviso. IVA no incluido."
 *   },
 *   assignedClientIds: [1,2,3],
 *   active: true,
 *   createdAt: <ts>,
 *   updatedAt: <ts>
 * }
 */

function makeId() {
  return `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function DEFAULT_PRICELIST() {
  return {
    id: makeId(),
    name: "Nueva lista B2B",
    segment: "distribuidor",
    segmentLabel: "Distribuidor",
    segmentDiscountPct: 10,
    basedOnList: "salePrice",
    rules: { includeAll: false, categories: [], brands: [], skus: [] },
    exclusions: { skus: [] },
    defaultTiers: [
      { minQty: 1, maxQty: 9, additionalDiscountPct: 0 },
      { minQty: 10, maxQty: 49, additionalDiscountPct: 3 },
      { minQty: 50, maxQty: null, additionalDiscountPct: 6 },
    ],
    skuOverrides: {},
    conditions: {
      paymentTerms: "50% anticipo, 50% contra entrega",
      validityDays: 15,
      deliveryTerms: "Puesto en almacén BTO",
      currency: "USD",
      notes: "Precios en USD sin IVA. Sujetos a cambio sin previo aviso.",
    },
    assignedClientIds: [],
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Resuelve reglas contra el catálogo y retorna array de productos que aplican
function resolveSkus(pricelist, products) {
  const rules = pricelist.rules || {};
  const excl = new Set((pricelist.exclusions?.skus || []).map((s) => String(s).toUpperCase()));

  const cats = new Set((rules.categories || []).map((c) => String(c).toLowerCase()));
  const brs = new Set((rules.brands || []).map((b) => String(b).toLowerCase()));
  const skus = new Set((rules.skus || []).map((s) => String(s).toUpperCase()));

  return products.filter((p) => {
    const sku = String(p.sku || p.code || "").toUpperCase();
    if (!sku) return false;
    if (excl.has(sku)) return false;
    if (rules.includeAll) return true;
    if (cats.size && p.category && cats.has(String(p.category).toLowerCase())) return true;
    if (brs.size && p.brand && brs.has(String(p.brand).toLowerCase())) return true;
    if (skus.has(sku)) return true;
    return false;
  });
}

function pickBasePrice(product, basedOnList) {
  const raw =
    basedOnList === "landedCost" ? product.landedCost :
    basedOnList === "minPrice"   ? product.minPrice   :
    product.salePrice;
  const n = Number(raw || 0);
  return isFinite(n) ? n : 0;
}

// Calcula precio final por SKU × tier
function materializePricelist(pricelist, products) {
  const applicable = resolveSkus(pricelist, products);
  const segDisc = Number(pricelist.segmentDiscountPct || 0) / 100;
  const items = applicable.map((p) => {
    const sku = String(p.sku || p.code || "").toUpperCase();
    const basePrice = pickBasePrice(p, pricelist.basedOnList);
    const override = pricelist.skuOverrides?.[sku] || {};
    const priceAfterSegment = basePrice * (1 - segDisc);
    const tiers = (override.tiers || pricelist.defaultTiers || []).map((t) => {
      const extra = Number(t.additionalDiscountPct || 0) / 100;
      const finalPrice = (override.priceOverride != null && Number(override.priceOverride) > 0)
        ? Number(override.priceOverride)
        : priceAfterSegment * (1 - extra);
      return {
        minQty: t.minQty,
        maxQty: t.maxQty,
        additionalDiscountPct: t.additionalDiscountPct || 0,
        price: Math.round(finalPrice * 100) / 100,
      };
    });
    return {
      sku,
      name: p.name || "",
      category: p.category || "",
      brand: p.brand || "",
      unit: p.unit || "und",
      basePrice: Math.round(basePrice * 100) / 100,
      priceAfterSegment: Math.round(priceAfterSegment * 100) / 100,
      hasPriceOverride: override.priceOverride != null && Number(override.priceOverride) > 0,
      hasTierOverride: Array.isArray(override.tiers) && override.tiers.length > 0,
      tiers,
      minPrice: Number(p.minPrice || 0) || null,
      landedCost: Number(p.landedCost || 0) || null,
      stock: Number(p.stock || 0),
    };
  });
  return {
    pricelistId: pricelist.id,
    name: pricelist.name,
    segment: pricelist.segment,
    segmentLabel: pricelist.segmentLabel,
    segmentDiscountPct: pricelist.segmentDiscountPct,
    basedOnList: pricelist.basedOnList,
    conditions: pricelist.conditions,
    generatedAt: new Date().toISOString(),
    itemsCount: items.length,
    items,
  };
}

export function registerPricelistsRoutes(app, pool, wrap) {
  // Lista todas las listas de precio
  app.get("/api/pricelists", wrap(async (req, res) => {
    const list = await readList(pool);
    res.json({ ok: true, pricelists: list });
  }));

  // Detalle
  app.get("/api/pricelists/:id", wrap(async (req, res) => {
    const list = await readList(pool);
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "not-found" });
    res.json({ ok: true, pricelist: p });
  }));

  // Crear
  app.post("/api/pricelists", wrap(async (req, res) => {
    const list = await readList(pool);
    const body = req.body || {};
    const created = {
      ...DEFAULT_PRICELIST(),
      ...body,
      id: makeId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.push(created);
    await writeList(pool, list);
    res.json({ ok: true, pricelist: created });
  }));

  // Actualizar (PATCH parcial)
  app.patch("/api/pricelists/:id", wrap(async (req, res) => {
    const list = await readList(pool);
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "not-found" });
    const body = req.body || {};
    list[idx] = { ...list[idx], ...body, id: list[idx].id, updatedAt: Date.now() };
    await writeList(pool, list);
    res.json({ ok: true, pricelist: list[idx] });
  }));

  // Eliminar
  app.delete("/api/pricelists/:id", wrap(async (req, res) => {
    const list = await readList(pool);
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "not-found" });
    const removed = list.splice(idx, 1)[0];
    await writeList(pool, list);
    // Limpiar asignación en clientes
    const clients = await readClients(pool);
    let touched = 0;
    for (const c of clients) {
      if (c.assignedPricelistId === removed.id) {
        c.assignedPricelistId = null;
        touched++;
      }
    }
    if (touched) await writeClients(pool, clients);
    res.json({ ok: true, clientsUnassigned: touched });
  }));

  // Materializar (resuelve reglas contra catálogo actual)
  app.post("/api/pricelists/:id/materialize", wrap(async (req, res) => {
    const list = await readList(pool);
    const pl = list.find((x) => x.id === req.params.id);
    if (!pl) return res.status(404).json({ ok: false, error: "not-found" });
    const products = await readProducts(pool);
    const mat = materializePricelist(pl, products);
    res.json({ ok: true, materialized: mat });
  }));

  // Asignar lista a clientes (bulk)
  app.post("/api/pricelists/:id/assign-clients", wrap(async (req, res) => {
    const list = await readList(pool);
    const pl = list.find((x) => x.id === req.params.id);
    if (!pl) return res.status(404).json({ ok: false, error: "not-found" });
    const { clientIds = [], mode = "add" } = req.body || {};
    const wanted = new Set(clientIds.map((n) => Number(n)));

    const clients = await readClients(pool);
    let assigned = 0;
    for (const c of clients) {
      const isWanted = wanted.has(Number(c.id));
      if (mode === "replace") {
        if (isWanted && c.assignedPricelistId !== pl.id) {
          c.assignedPricelistId = pl.id;
          assigned++;
        } else if (!isWanted && c.assignedPricelistId === pl.id) {
          c.assignedPricelistId = null;
        }
      } else {
        if (isWanted && c.assignedPricelistId !== pl.id) {
          c.assignedPricelistId = pl.id;
          assigned++;
        }
      }
    }
    await writeClients(pool, clients);

    // Actualizar assignedClientIds en pricelist (derivado)
    pl.assignedClientIds = clients.filter((c) => c.assignedPricelistId === pl.id).map((c) => c.id);
    pl.updatedAt = Date.now();
    const idx = list.findIndex((x) => x.id === pl.id);
    list[idx] = pl;
    await writeList(pool, list);

    res.json({ ok: true, assigned, totalAssigned: pl.assignedClientIds.length });
  }));

  // Retorna lista asignada + materializada de un cliente (usa el cotizador)
  app.get("/api/pricelists/client/:clientId", wrap(async (req, res) => {
    const clientId = Number(req.params.clientId);
    const clients = await readClients(pool);
    const c = clients.find((x) => Number(x.id) === clientId);
    if (!c) return res.status(404).json({ ok: false, error: "client-not-found" });
    if (!c.assignedPricelistId) return res.json({ ok: true, hasPricelist: false });
    const list = await readList(pool);
    const pl = list.find((x) => x.id === c.assignedPricelistId);
    if (!pl || !pl.active) return res.json({ ok: true, hasPricelist: false });
    const products = await readProducts(pool);
    const mat = materializePricelist(pl, products);
    res.json({ ok: true, hasPricelist: true, materialized: mat });
  }));

  // Endpoint auxiliar: categorías y marcas distintas del catálogo (para poblar UI de reglas)
  app.get("/api/pricelists-helpers/catalog-facets", wrap(async (req, res) => {
    const products = await readProducts(pool);
    const cats = new Map();
    const brs = new Map();
    for (const p of products) {
      const c = String(p.category || "").toLowerCase();
      if (c) cats.set(c, (cats.get(c) || 0) + 1);
      const b = String(p.brand || "").toLowerCase();
      if (b) brs.set(b, (brs.get(b) || 0) + 1);
    }
    const categories = [...cats.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count);
    const brands = [...brs.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count);
    res.json({ ok: true, categories, brands, totalProducts: products.length });
  }));
}
