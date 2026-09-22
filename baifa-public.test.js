import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("catálogo público no expone precio Embajador ni modifica datos internos", async () => {
  const source = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const start = source.indexOf('app.get("/api/public/baifa/price-list"');
  const end = source.indexOf("// Settings de la lista de precios BAIFA", start);
  assert.ok(start >= 0 && end > start);
  const items = [
    { id: 0, published: true, kva: "750KVA MOTOR KTA19", priceExpress: 117000, priceDirect: 110000, priceAmbassador: 115000 },
    { id: 1, published: false, kva: "750KVA 254/440", priceAmbassador: 128000 },
  ];
  let handler, result;
  const headers = {};
  vm.runInNewContext(source.slice(start, end), {
    app: { get: (_path, fn) => { handler = fn; } },
    wrap: fn => fn,
    readCol: async () => items,
    readSingleton: async () => ({ listDate: "2026-09-21" }),
    console,
  });
  await handler({}, {
    set: (key, value) => { headers[key] = value; },
    json: body => { result = body; },
  });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].id, 0);
  assert.equal(result.items[0].priceExpress, 117000);
  assert.equal(result.items[0].priceDirect, 110000);
  assert.equal(Object.hasOwn(result.items[0], "priceAmbassador"), false);
  assert.equal(items[0].priceAmbassador, 115000);
  assert.equal(headers["Cache-Control"], "no-store");
});
