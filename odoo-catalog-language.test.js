import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the actual sync function without starting Express or touching Odoo/PG.
const source = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncOdooCatalog(");
const end = source.indexOf("// POST /api/erp/products/bulk-update-manual-prices", start);
assert.ok(start >= 0 && end > start);
const syncSource = source.slice(start, end);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ lang = "es_VE", contextError = false, pages = [[]] } = {}) {
  const calls = [];
  const writes = [];
  const dbWrites = [];
  const manual = { id: 7, sku: "MANUAL", name: "Equipo manual" };
  const odoo = {
    isConfigured: () => true,
    execute: async (...args) => {
      calls.push({ method: "execute", args: plain(args) });
      if (contextError) throw new Error("Odoo unavailable");
      return { lang, allowed_company_ids: [1], tz: "America/Caracas" };
    },
    searchRead: async (...args) => {
      calls.push({ method: "searchRead", args: plain(args) });
      const opts = args[3];
      return (pages[opts.offset / 2000] || []).map(row => ({
        ...row,
        name: opts.context?.lang === "es_VE" ? row.spanishName : "750 KVA",
      }));
    },
  };
  const sandbox = {
    collectionContext:{},withCatalogLock:async(_pool,_context,merge)=>merge(),
    odoo,
    getOdooProductAvailableFields: async () => new Set(),
    getCopikonCompanyId: async () => 12,
    readCol: async key => {
      assert.equal(key, "erpProducts");
      return [manual];
    },
    writeCol: async (key, value) => writes.push({ key, value: plain(value) }),
    mapOdooProduct: op => ({
      id: op.id, odooId: op.id, sku: op.default_code, name: op.name, syncStatus: "odoo",
    }),
    pool: { query: async (...args) => dbWrites.push(plain(args)) },
    console: { log() {}, warn() {} },
  };
  const sync = vm.runInNewContext(`${syncSource}\nsyncOdooCatalog`, sandbox);
  return { sync, calls, writes, dbWrites, manual };
}

test("catalog sync uses session language on every page and keeps company-12 priority", async () => {
  const old = { id: 28444, default_code: "BF-C550S-60", company_id: [1, "Old"], spanishName: "750 KVA" };
  const current = {
    id: 83865, default_code: "BF-C550S-60", company_id: [12, "Current"],
    spanishName: "625 KVA STANDBY // KTA19-G4 // S5L1D-D41 // 220V/127V",
  };
  const first = Array.from({ length: 1999 }, (_, i) => ({
    id: 100 + i, default_code: `SKU-${i}`, company_id: [1, "Old"], spanishName: `Producto ${i}`,
  }));
  const f = fixture({ pages: [[...first, old], [current]] });
  const meta = await f.sync();
  const reads = f.calls.filter(c => c.method === "searchRead");
  assert.equal(reads.length, 2);
  assert.deepEqual(f.calls[0], {
    method: "execute", args: ["res.users", "context_get", [], {}],
  });
  for (const { args: [model, domain, fields, opts] } of reads) {
    assert.equal(model, "product.product");
    assert.deepEqual(domain, [["sale_ok", "=", true], ["active", "=", true]]);
    assert.deepEqual(opts.context, { lang: "es_VE" });
    assert.equal(opts.order, "id asc");
    assert.ok(fields.includes("name") && fields.includes("list_price") && fields.includes("company_id"));
  }
  assert.deepEqual(reads.map(r => r.args[3].offset), [0, 2000]);
  const result = f.writes[0].value;
  assert.equal(result.filter(p => p.sku === current.default_code).length, 1);
  assert.equal(result.find(p => p.sku === current.default_code).name, current.spanishName);
  assert.equal(result.find(p => p.sku === current.default_code).odooId, 83865);
  assert.deepEqual(result.find(p => p.id === 7), f.manual);
  assert.equal(meta.language, "es_VE");
  assert.equal(meta.companyId, 12);
  assert.equal(meta.odooCount, 2001);
  assert.equal(meta.odooDeduped, 2000);
  assert.equal(JSON.parse(f.dbWrites[0][1][1]).language, "es_VE");
});

test("missing or invalid language aborts before product reads and writes", async () => {
  for (const lang of [null, false, "", "   ", 123]) {
    const f = fixture({ lang });
    await assert.rejects(f.sync(), /idioma/);
    assert.equal(f.calls.filter(c => c.method === "searchRead").length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.dbWrites.length, 0);
  }
});

test("context RPC failure aborts without falling back to untranslated product names", async () => {
  const f = fixture({ contextError: true });
  await assert.rejects(f.sync(), /Odoo unavailable/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.dbWrites.length, 0);
});

test("language comes from Odoo, while pagination limit and image option remain intact", async () => {
  const f = fixture({ lang: "en_US" });
  const meta = await f.sync({ limit: 23, includeImages: true });
  const read = f.calls.find(c => c.method === "searchRead");
  assert.deepEqual(read.args[3].context, { lang: "en_US" });
  assert.equal(read.args[3].limit, 23);
  assert.ok(read.args[2].includes("image_128"));
  assert.equal(meta.language, "en_US");
});
