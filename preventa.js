// Módulo Preventa Corporativa
// Campañas de preventa con catálogo de SKUs curados, materiales de apoyo,
// reserva lógica de stock por 72h y flujo de comprobante → oportunidad aprobada.
//
// Storage (todo en tabla kv):
//   preventaCampaigns → [{id, name, brandLabel, description, materials{},
//                          conditions{}, startDate, endDate, active, createdBy, createdAt}]
//   preventaProducts  → {campaignId: [{sku, name, priceListed, pricePreventa,
//                                       stockOffered, imageUrl, brand, category}]}
//   preventaReservations → [{id, campaignId, sku, qty, salespersonId, salespersonName,
//                             clientId, clientName, clientRif, clientContact,
//                             status, reservedAt, expiresAt, paymentId?, leadId?, notes}]
//   preventaPayments  → [{id, reservationId, amount, currency, method, reference,
//                          bank, dateReceived, attachmentUrl, attachmentName,
//                          submittedBy, submittedAt, validatedBy?, validatedAt?,
//                          validationStatus, validationNotes}]
//
// Endpoints:
//   Campañas:
//     GET    /api/preventa/campaigns                       → lista todas
//     GET    /api/preventa/campaigns/:id                   → detalle + productos + stats
//     POST   /api/preventa/campaigns                       → crear
//     PATCH  /api/preventa/campaigns/:id                   → editar (materiales, condiciones, etc.)
//     DELETE /api/preventa/campaigns/:id                   → borrar (y sus productos + reservas)
//     POST   /api/preventa/campaigns/:id/products          → set productos {items:[...]}
//     GET    /api/preventa/campaigns/:id/products          → productos + stock reservado vigente
//     GET    /api/preventa/campaigns/:id/stats             → estadísticas ventas por vendedor
//   Reservas:
//     GET    /api/preventa/reservations                    → todas (filtros ?campaignId=&status=&salespersonId=)
//     POST   /api/preventa/reservations                    → crear (aparta stock 72h)
//     PATCH  /api/preventa/reservations/:id                → editar (solo notas)
//     DELETE /api/preventa/reservations/:id                → liberar reserva
//     POST   /api/preventa/reservations/expire-check       → cron interno: expira vencidas
//   Pagos:
//     POST   /api/preventa/reservations/:id/payment        → adjunta comprobante
//     POST   /api/preventa/payments/:paymentId/validate    → valida (aprobar/rechazar). Si aprueba: crea lead + marca reserva pagada
//     GET    /api/preventa/payments                        → todos (filtros ?status=)

const K_CAMPAIGNS = "preventaCampaigns";
const K_PRODUCTS = "preventaProducts";
const K_RESERVATIONS = "preventaReservations";
const K_PAYMENTS = "preventaPayments";

const RESERVA_HORAS = 72;

async function kvGet(pool, key, fallback) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  if (!r.rows[0]) return fallback;
  return r.rows[0].value;
}
async function kvSet(pool, key, value) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value ?? null), Date.now()]
  );
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() { return new Date().toISOString(); }

function addHours(iso, hours) {
  const d = new Date(iso || nowIso());
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

// Aparta lógicamente: suma reservas activas por SKU dentro de una campaña.
function computeReservedQty(reservations, campaignId, sku, excludeId = null) {
  const now = Date.now();
  return reservations
    .filter((r) => r.campaignId === campaignId && r.sku === sku)
    .filter((r) => r.id !== excludeId)
    .filter((r) => {
      // Considera activa si aún no expiró y no está liberada/rechazada
      if (["released", "expired", "rejected"].includes(r.status)) return false;
      // Pending y paid (pero aún no facturado) cuentan como apartadas
      if (r.status === "pending" || r.status === "payment_pending" || r.status === "paid") {
        if (r.status === "pending" || r.status === "payment_pending") {
          return new Date(r.expiresAt).getTime() > now;
        }
        return true;
      }
      return false;
    })
    .reduce((acc, r) => acc + Number(r.qty || 0), 0);
}

async function expireStaleReservations(pool) {
  const list = (await kvGet(pool, K_RESERVATIONS, [])) || [];
  const now = Date.now();
  let changed = false;
  const upd = list.map((r) => {
    if ((r.status === "pending" || r.status === "payment_pending") &&
        new Date(r.expiresAt).getTime() <= now) {
      changed = true;
      return { ...r, status: "expired", expiredAt: nowIso() };
    }
    return r;
  });
  if (changed) await kvSet(pool, K_RESERVATIONS, upd);
  return { expired: upd.filter((r) => r.status === "expired" && !list.find((o) => o.id === r.id && o.status === "expired")).length };
}

function defaultCampaign(input = {}) {
  return {
    id: newId("cmp"),
    name: input.name || "Campaña de Preventa",
    brandLabel: input.brandLabel || "",
    description: input.description || "",
    startDate: input.startDate || nowIso(),
    endDate: input.endDate || addHours(nowIso(), 24 * 30),
    active: input.active !== false,
    materials: {
      fichasTecnicas: [], // [{sku, name, url, uploadedAt, uploadedBy}]
      kitCampana: [],     // [{name, type: 'imagen'|'video'|'plantilla-wa'|'otro', url, uploadedAt, uploadedBy}]
      condicionesUrl: input.materials?.condicionesUrl || "",
      listaPreciosPdfUrl: input.materials?.listaPreciosPdfUrl || "",
      listaPreciosXlsxUrl: input.materials?.listaPreciosXlsxUrl || "",
    },
    conditions: {
      reservaHoras: RESERVA_HORAS,
      currency: input.conditions?.currency || "USD",
      paymentMethods: input.conditions?.paymentMethods || ["Zelle", "Transferencia BsD", "Transferencia USD"],
      notes: input.conditions?.notes || "Apartado válido por 72 horas contadas desde la reserva. Vencido este plazo sin comprobante validado, el producto se libera automáticamente.",
    },
    createdBy: input.createdBy || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// === ATTACHMENTS (base64 en kv, patrón task-attachment) ===
async function saveAttachment(pool, fileId, data) {
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [`preventa-attachment:${fileId}`, JSON.stringify(data), Date.now()]
  );
}
async function loadAttachment(pool, fileId) {
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [`preventa-attachment:${fileId}`]);
  return r.rows[0] ? r.rows[0].value : null;
}

export function registerPreventaRoutes(app, pool, wrap) {
  // === ATTACHMENTS ===
  app.post("/api/preventa/attachments", wrap(async (req, res) => {
    const { name, mime, dataUrl } = req.body || {};
    if (!dataUrl) return res.status(400).json({ ok: false, error: "missing_dataUrl" });
    // Estimación tamaño base64 → bytes: (n * 3/4) - padding
    const size = Math.floor((dataUrl.length * 3) / 4);
    if (size > 25 * 1024 * 1024) return res.status(413).json({ ok: false, error: "too_large", max: "25MB" });
    const fileId = newId("att");
    await saveAttachment(pool, fileId, { name: name || "archivo", mime: mime || "application/octet-stream", dataUrl, size, uploadedAt: nowIso() });
    res.json({ ok: true, fileId, url: `/api/preventa/attachments/${fileId}`, name, size });
  }));

  app.get("/api/preventa/attachments/:id", wrap(async (req, res) => {
    const att = await loadAttachment(pool, req.params.id);
    if (!att) return res.status(404).send("not_found");
    // dataUrl formato: data:mime/type;base64,XXXX
    const m = /^data:([^;]+);base64,(.+)$/.exec(att.dataUrl || "");
    if (!m) return res.status(500).send("invalid_dataUrl");
    const buf = Buffer.from(m[2], "base64");
    res.setHeader("Content-Type", m[1] || att.mime || "application/octet-stream");
    const safeName = (att.name || "archivo").replace(/[^\w\-\.\s]/g, "_");
    const dispo = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${dispo}; filename="${safeName}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buf);
  }));

  // === CAMPAÑAS ===

  app.get("/api/preventa/campaigns", wrap(async (_req, res) => {
    const list = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    const enriched = list.map((c) => ({
      ...c,
      productCount: (productsMap[c.id] || []).length,
    }));
    res.json({ ok: true, campaigns: enriched });
  }));

  app.get("/api/preventa/campaigns/:id", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: "campaign_not_found" });
    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    const reservations = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const products = (productsMap[c.id] || []).map((p) => ({
      ...p,
      stockReserved: computeReservedQty(reservations, c.id, p.sku),
      stockAvailable: Math.max(0, Number(p.stockOffered || 0) - computeReservedQty(reservations, c.id, p.sku)),
    }));
    res.json({ ok: true, campaign: c, products });
  }));

  app.post("/api/preventa/campaigns", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const c = defaultCampaign(req.body || {});
    list.push(c);
    await kvSet(pool, K_CAMPAIGNS, list);
    res.json({ ok: true, campaign: c });
  }));

  app.patch("/api/preventa/campaigns/:id", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "campaign_not_found" });
    const merged = {
      ...list[idx],
      ...req.body,
      materials: { ...list[idx].materials, ...(req.body?.materials || {}) },
      conditions: { ...list[idx].conditions, ...(req.body?.conditions || {}) },
      id: list[idx].id,
      createdAt: list[idx].createdAt,
      updatedAt: nowIso(),
    };
    list[idx] = merged;
    await kvSet(pool, K_CAMPAIGNS, list);
    res.json({ ok: true, campaign: merged });
  }));

  app.delete("/api/preventa/campaigns/:id", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const filtered = list.filter((x) => x.id !== req.params.id);
    if (filtered.length === list.length) return res.status(404).json({ ok: false, error: "campaign_not_found" });
    await kvSet(pool, K_CAMPAIGNS, filtered);
    // Limpia productos + reservas + pagos huérfanos
    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    delete productsMap[req.params.id];
    await kvSet(pool, K_PRODUCTS, productsMap);
    const reservations = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const remaining = reservations.filter((r) => r.campaignId !== req.params.id);
    await kvSet(pool, K_RESERVATIONS, remaining);
    res.json({ ok: true, deletedId: req.params.id });
  }));

  // === PRODUCTOS DE CAMPAÑA ===

  app.post("/api/preventa/campaigns/:id/products", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: "campaign_not_found" });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const cleaned = items.map((i) => ({
      sku: String(i.sku || "").trim(),
      name: String(i.name || "").trim(),
      priceListed: Number(i.priceListed || 0),
      pricePreventa: Number(i.pricePreventa || 0),
      stockOffered: Math.max(0, Math.floor(Number(i.stockOffered || 0))),
      imageUrl: i.imageUrl || "",
      brand: i.brand || "",
      category: i.category || "",
    })).filter((i) => i.sku);
    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    productsMap[req.params.id] = cleaned;
    await kvSet(pool, K_PRODUCTS, productsMap);
    res.json({ ok: true, count: cleaned.length });
  }));

  app.get("/api/preventa/campaigns/:id/products", wrap(async (req, res) => {
    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    const items = productsMap[req.params.id] || [];
    const reservations = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const enriched = items.map((p) => {
      const reserved = computeReservedQty(reservations, req.params.id, p.sku);
      return {
        ...p,
        stockReserved: reserved,
        stockAvailable: Math.max(0, Number(p.stockOffered || 0) - reserved),
      };
    });
    res.json({ ok: true, items: enriched });
  }));

  app.get("/api/preventa/campaigns/:id/stats", wrap(async (req, res) => {
    await expireStaleReservations(pool);
    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    const items = productsMap[req.params.id] || [];
    const reservations = (await kvGet(pool, K_RESERVATIONS, []))
      || [];
    const relevant = reservations.filter((r) => r.campaignId === req.params.id);

    const bySales = {};
    for (const r of relevant) {
      const key = r.salespersonId || "sin-asignar";
      if (!bySales[key]) {
        bySales[key] = {
          salespersonId: r.salespersonId,
          salespersonName: r.salespersonName || "Sin asignar",
          reservado: 0, pagado: 0, expirado: 0, rechazado: 0, liberado: 0,
          unidadesReservadas: 0, unidadesPagadas: 0,
          montoReservadoUsd: 0, montoPagadoUsd: 0,
        };
      }
      const price = (items.find((p) => p.sku === r.sku)?.pricePreventa) || 0;
      const monto = price * Number(r.qty || 0);
      bySales[key][r.status === "paid" ? "pagado" : r.status === "expired" ? "expirado" : r.status === "rejected" ? "rechazado" : r.status === "released" ? "liberado" : "reservado"]++;
      if (r.status === "pending" || r.status === "payment_pending") {
        bySales[key].unidadesReservadas += Number(r.qty || 0);
        bySales[key].montoReservadoUsd += monto;
      }
      if (r.status === "paid") {
        bySales[key].unidadesPagadas += Number(r.qty || 0);
        bySales[key].montoPagadoUsd += monto;
      }
    }

    const bySku = items.map((p) => {
      const rs = relevant.filter((r) => r.sku === p.sku);
      const activo = computeReservedQty(reservations, req.params.id, p.sku);
      return {
        sku: p.sku,
        name: p.name,
        stockOffered: p.stockOffered,
        stockReservado: activo,
        stockDisponible: Math.max(0, p.stockOffered - activo),
        unidadesPagadas: rs.filter((r) => r.status === "paid").reduce((a, r) => a + Number(r.qty || 0), 0),
        unidadesExpiradas: rs.filter((r) => r.status === "expired").reduce((a, r) => a + Number(r.qty || 0), 0),
      };
    });

    res.json({
      ok: true,
      totalReservas: relevant.length,
      totalPagadas: relevant.filter((r) => r.status === "paid").length,
      totalPendientes: relevant.filter((r) => r.status === "pending" || r.status === "payment_pending").length,
      totalExpiradas: relevant.filter((r) => r.status === "expired").length,
      unidadesPagadas: relevant.filter((r) => r.status === "paid").reduce((a, r) => a + Number(r.qty || 0), 0),
      bySalesperson: Object.values(bySales).sort((a, b) => b.montoPagadoUsd - a.montoPagadoUsd),
      bySku,
    });
  }));

  // === RESERVAS ===

  app.get("/api/preventa/reservations", wrap(async (req, res) => {
    await expireStaleReservations(pool);
    const list = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    let out = list;
    if (req.query.campaignId) out = out.filter((r) => r.campaignId === String(req.query.campaignId));
    if (req.query.status) out = out.filter((r) => r.status === String(req.query.status));
    if (req.query.salespersonId) out = out.filter((r) => String(r.salespersonId) === String(req.query.salespersonId));
    out = out.sort((a, b) => new Date(b.reservedAt).getTime() - new Date(a.reservedAt).getTime());
    res.json({ ok: true, reservations: out });
  }));

  app.post("/api/preventa/reservations", wrap(async (req, res) => {
    await expireStaleReservations(pool);
    const b = req.body || {};
    if (!b.campaignId || !b.sku || !b.qty) {
      return res.status(400).json({ ok: false, error: "missing_fields", required: ["campaignId", "sku", "qty"] });
    }
    const campaigns = (await kvGet(pool, K_CAMPAIGNS, [])) || [];
    const camp = campaigns.find((c) => c.id === b.campaignId);
    if (!camp) return res.status(404).json({ ok: false, error: "campaign_not_found" });
    if (!camp.active) return res.status(400).json({ ok: false, error: "campaign_inactive" });

    const productsMap = (await kvGet(pool, K_PRODUCTS, {})) || {};
    const prod = (productsMap[b.campaignId] || []).find((p) => p.sku === b.sku);
    if (!prod) return res.status(404).json({ ok: false, error: "product_not_in_campaign" });

    const reservations = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const reserved = computeReservedQty(reservations, b.campaignId, b.sku);
    const available = Math.max(0, Number(prod.stockOffered || 0) - reserved);
    const qty = Math.max(1, Math.floor(Number(b.qty || 0)));
    if (qty > available) {
      return res.status(400).json({ ok: false, error: "insufficient_stock", stockAvailable: available });
    }

    const reservedAt = nowIso();
    const expiresAt = addHours(reservedAt, camp.conditions?.reservaHoras || RESERVA_HORAS);
    const reservation = {
      id: newId("rsv"),
      campaignId: b.campaignId,
      sku: b.sku,
      productName: prod.name,
      qty,
      pricePreventa: prod.pricePreventa,
      totalUsd: prod.pricePreventa * qty,
      salespersonId: b.salespersonId || null,
      salespersonName: b.salespersonName || "",
      clientId: b.clientId || null,
      clientName: b.clientName || "",
      clientRif: b.clientRif || "",
      clientContact: b.clientContact || "",
      status: "pending", // pending → payment_pending → paid | expired | released | rejected
      reservedAt,
      expiresAt,
      paymentId: null,
      leadId: null,
      notes: b.notes || "",
    };
    reservations.push(reservation);
    await kvSet(pool, K_RESERVATIONS, reservations);
    res.json({ ok: true, reservation });
  }));

  app.patch("/api/preventa/reservations/:id", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "reservation_not_found" });
    // Solo permitimos editar notas + datos cliente si sigue pending
    const allow = ["notes", "clientName", "clientRif", "clientContact", "clientId"];
    for (const k of allow) if (req.body?.[k] !== undefined) list[idx][k] = req.body[k];
    await kvSet(pool, K_RESERVATIONS, list);
    res.json({ ok: true, reservation: list[idx] });
  }));

  app.delete("/api/preventa/reservations/:id", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "reservation_not_found" });
    if (list[idx].status === "paid") return res.status(400).json({ ok: false, error: "cannot_release_paid" });
    list[idx] = { ...list[idx], status: "released", releasedAt: nowIso() };
    await kvSet(pool, K_RESERVATIONS, list);
    res.json({ ok: true, reservation: list[idx] });
  }));

  app.post("/api/preventa/reservations/expire-check", wrap(async (_req, res) => {
    const result = await expireStaleReservations(pool);
    res.json({ ok: true, ...result });
  }));

  // === PAGOS ===

  app.post("/api/preventa/reservations/:id/payment", wrap(async (req, res) => {
    const list = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "reservation_not_found" });
    if (["expired", "rejected", "released"].includes(list[idx].status)) {
      return res.status(400).json({ ok: false, error: `reservation_${list[idx].status}` });
    }
    const b = req.body || {};
    const payments = (await kvGet(pool, K_PAYMENTS, [])) || [];
    const payment = {
      id: newId("pay"),
      reservationId: list[idx].id,
      amount: Number(b.amount || 0),
      currency: b.currency || "USD",
      method: b.method || "",
      reference: b.reference || "",
      bank: b.bank || "",
      dateReceived: b.dateReceived || nowIso(),
      attachmentUrl: b.attachmentUrl || "",
      attachmentName: b.attachmentName || "",
      submittedBy: b.submittedBy || list[idx].salespersonName || "",
      submittedById: b.submittedById || list[idx].salespersonId || null,
      submittedAt: nowIso(),
      validationStatus: "pending", // pending | approved | rejected
      validatedBy: null,
      validatedAt: null,
      validationNotes: "",
    };
    payments.push(payment);
    await kvSet(pool, K_PAYMENTS, payments);
    // Marca reserva payment_pending y refresca expiresAt +72h desde envío pago (por si Tesorería tarda)
    list[idx] = { ...list[idx], status: "payment_pending", paymentId: payment.id, paymentSubmittedAt: nowIso() };
    await kvSet(pool, K_RESERVATIONS, list);
    res.json({ ok: true, payment, reservation: list[idx] });
  }));

  app.get("/api/preventa/payments", wrap(async (req, res) => {
    const payments = (await kvGet(pool, K_PAYMENTS, [])) || [];
    let out = payments;
    if (req.query.status) out = out.filter((p) => p.validationStatus === String(req.query.status));
    out = out.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    res.json({ ok: true, payments: out });
  }));

  app.post("/api/preventa/payments/:paymentId/validate", wrap(async (req, res) => {
    const payments = (await kvGet(pool, K_PAYMENTS, [])) || [];
    const idx = payments.findIndex((p) => p.id === req.params.paymentId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "payment_not_found" });
    const approve = req.body?.decision === "approve";
    const validatorName = req.body?.validatedBy || "Administración";
    payments[idx] = {
      ...payments[idx],
      validationStatus: approve ? "approved" : "rejected",
      validatedBy: validatorName,
      validatedAt: nowIso(),
      validationNotes: req.body?.notes || "",
    };
    await kvSet(pool, K_PAYMENTS, payments);

    // Actualiza reserva vinculada
    const reservations = (await kvGet(pool, K_RESERVATIONS, [])) || [];
    const ridx = reservations.findIndex((r) => r.id === payments[idx].reservationId);
    if (ridx >= 0) {
      if (approve) {
        // Crear lead 'Preventa Aprobada' en pipeline
        const leadId = await createPreventaLead(pool, reservations[ridx], payments[idx]);
        reservations[ridx] = {
          ...reservations[ridx],
          status: "paid",
          paidAt: nowIso(),
          leadId,
        };
      } else {
        reservations[ridx] = {
          ...reservations[ridx],
          status: "rejected",
          rejectedAt: nowIso(),
        };
      }
      await kvSet(pool, K_RESERVATIONS, reservations);
    }
    res.json({ ok: true, payment: payments[idx], reservation: ridx >= 0 ? reservations[ridx] : null });
  }));
}

async function createPreventaLead(pool, reservation, payment) {
  const leads = (await kvGet(pool, "leads", [])) || [];
  const id = newId("lead");
  const lead = {
    id,
    source: "preventa",
    stage: "aprobada",
    priority: "alta",
    origin: `Preventa ${reservation.campaignId}`,
    clientName: reservation.clientName || "Cliente Preventa",
    clientRif: reservation.clientRif || "",
    clientContact: reservation.clientContact || "",
    salespersonId: reservation.salespersonId,
    salespersonName: reservation.salespersonName,
    productSku: reservation.sku,
    productName: reservation.productName,
    qty: reservation.qty,
    priceUsd: reservation.pricePreventa,
    totalUsd: reservation.totalUsd,
    payment: {
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      reference: payment.reference,
      bank: payment.bank,
      dateReceived: payment.dateReceived,
      attachmentUrl: payment.attachmentUrl,
      validatedBy: payment.validatedBy,
      validatedAt: payment.validatedAt,
    },
    preventaReservationId: reservation.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    notes: `Oportunidad creada automáticamente desde Preventa. Reserva ${reservation.id} pagada y validada por ${payment.validatedBy}.`,
  };
  leads.push(lead);
  await kvSet(pool, "leads", leads);
  return id;
}
