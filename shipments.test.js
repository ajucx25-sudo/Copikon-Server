import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessFor, createItem, emptyState, importWorkbook, parseWorkbook, reviewFlags, updateItem, validateItem } from "./shipments-core.js";
import { withShipmentState } from "./shipments.js";

const parsed = parseWorkbook(readFileSync(new URL("./seeds/seguimiento-stock-generadores.xlsx", import.meta.url)));
const meta = { userId: 1, userName: "QA", fileName: "seguimiento.xlsx" };
const initial = () => importWorkbook(emptyState(), parsed, meta);

test("conserva 92 filas, 142 unidades y valores originales, sin errores", () => {
  assert.equal(parsed.records.length, 92);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.records.reduce((s, x) => s + x.quantity, 0), 142);
  assert.equal(initial().result.added, 92);
  assert.ok(parsed.records.every(x => x.source.values.length === 12));
});
test("reimportación exacta no duplica equipos", () => {
  const result = importWorkbook(initial().state, parsed, meta);
  assert.equal(result.result.added, 0);
  assert.equal(result.result.duplicates, 92);
  assert.equal(result.state.items.length, 92);
});
test("edición, historial y conflicto de versión", () => {
  const state = initial().state, item = state.items[0];
  const result = updateItem(state, item.id, { ...item, notes: "Revisión QA" }, 1, meta);
  assert.equal(result.item.version, 2);
  assert.equal(result.state.notes[0].changes.notes.to, "Revisión QA");
  assert.throws(() => updateItem(result.state, item.id, item, 1, meta), e => e.status === 409);
  assert.equal(updateItem(result.state, item.id, result.item, 2, meta).item.version, 2);
});
test("validación y permisos", () => {
  const item = parsed.records[0];
  assert.throws(() => validateItem({ ...item, quantity: 0 }), e => e.status === 400);
  assert.throws(() => validateItem({ ...item, quantity: 2, serial: "QA" }), e => e.status === 400);
  assert.throws(() => validateItem({ ...item, eta: "2026-02-30" }), e => e.status === 400);
  assert.deepEqual(accessFor({ moduleAccess: '["generators-ventas"]' }), { read: true, write: false });
  assert.deepEqual(accessFor({ moduleAccess: "bad json" }), { read: false, write: false });
  assert.equal(accessFor({ moduleAccess: '["generators-embarques"]' }).write, true);
  assert.ok(reviewFlags({ ...item, stage: "En tránsito", eta: "2026-01-01", bl: "" }, "2026-09-21").length >= 2);
  assert.equal(createItem(emptyState(), item, meta).state.items.length, 1);
});
test("las operaciones usan conexión, bloqueo, commit y liberación", async () => {
  const calls = [], state = initial().state;
  const client = { query: async (sql) => { calls.push(sql); return { rows: sql.startsWith("SELECT value") ? [{ value: state }] : [] }; }, release: () => calls.push("release") };
  await withShipmentState({ connect: async () => client }, s => ({ state: s }));
  assert.equal(calls[0], "BEGIN");
  assert.ok(calls[1].includes("pg_advisory_xact_lock"));
  assert.ok(calls[3].startsWith("INSERT INTO kv"));
  assert.deepEqual(calls.slice(-2), ["COMMIT", "release"]);
  calls.length = 0;
  await assert.rejects(() => withShipmentState({ connect: async () => client }, () => { throw Error("conflicto"); }), /conflicto/);
  assert.deepEqual(calls.slice(-2), ["ROLLBACK", "release"]);
});
