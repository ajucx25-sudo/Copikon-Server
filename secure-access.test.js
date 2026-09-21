import test from "node:test";
import assert from "node:assert/strict";
import { createSessions, canAccessPath, safeUser, hashPassword, verifyPassword, protectCredentials } from "./secure-access.js";

test("credentials are salted, verified and migrated without changing account data", async () => {
  const password = "synthetic-test-password";
  const hashed = await hashPassword(password);
  assert.notEqual(hashed, password);
  assert.notEqual(await hashPassword(password), hashed);
  assert.equal(await hashPassword(hashed), hashed);
  assert.equal(await verifyPassword(password, hashed), true);
  assert.equal(await verifyPassword("wrong", hashed), false);
  assert.equal(await verifyPassword(hashed, hashed), false);
  assert.equal(await verifyPassword(password, password), false);
  const [record] = await protectCredentials([{id:9,firstName:"QA",password}]);
  assert.equal(record.id,9); assert.equal(record.firstName,"QA");
  assert.equal(await verifyPassword(password,record.password),true);
});

function fixture() {
  const records = new Map();
  const employees = [{ id: 1, username: "admin", level: "ceo", password: "test-only", status: "active" }];
  const partners = [{ id: 2, password: "test-only", status: "active", canLogin: true }];
  const pool = { async query(sql, args) {
    if (sql.startsWith("INSERT")) records.set(args[0], { subject: args[1], credential_digest: args[2], expires_at: args[3] });
    if (sql.startsWith("DELETE")) records.delete(args[0]);
    return { rows: sql.startsWith("SELECT") && records.has(args[0]) ? [records.get(args[0])] : [] };
  }};
  const sessions = createSessions(pool, async col => col === "employees" ? employees : partners, u => ({ id: `p-${u.id}`, isPartner: true }));
  const req = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { records, employees, partners, sessions, req };
}
test("anonymous, timestamp and forged tokens fail closed", async () => {
  const { sessions, req } = fixture();
  for (const token of [null, "srv-1-17211111", `srv-1-${"0".repeat(64)}`]) {
    assert.equal(await sessions.authenticate(req(token)), null);
  }
});
test("random persistent sessions omit passwords, revoke and expire", async () => {
  const { sessions, employees, records, req } = fixture();
  const token = await sessions.issue(employees[0]);
  const another = await sessions.issue(employees[0]);
  assert.notEqual(token, another);
  assert.match(token, /^srv-1-[a-f0-9]{64}$/);
  assert.equal(records.has(token), false, "raw bearer must not be stored");
  assert.equal((await sessions.authenticate(req(token))).username, "admin");
  assert.equal((await sessions.authenticate(req(token))).password, undefined);
  await sessions.revoke(req(token));
  assert.equal(await sessions.authenticate(req(token)), null);
  for (const record of records.values()) record.expires_at = Date.now() - 1;
  assert.equal(await sessions.authenticate(req(another)), null);
});
test("password changes and account disable immediately invalidate sessions", async () => {
  const { sessions, employees, req } = fixture();
  const token = await sessions.issue(employees[0]);
  employees[0].password = "changed-test";
  assert.equal(await sessions.authenticate(req(token)), null);
  const replacement = await sessions.issue(employees[0]);
  employees[0].canLogin = false;
  assert.equal(await sessions.authenticate(req(replacement)), null);
});
test("partner credentials resolve only a partner identity", async () => {
  const { sessions, partners, req } = fixture();
  const token = await sessions.issue(partners[0], true);
  assert.deepEqual(await sessions.authenticate(req(token)), { id: "p-2", isPartner: true });
});
test("role checks deny unprivileged mutations and permit intended modules", () => {
  const user = { level: "vendedor", moduleAccess: '["generators-ventas"]', menuAccess: '["rrhh"]' };
  assert.equal(canAccessPath(user, "/api/employees/1", "PATCH"), false);
  assert.equal(canAccessPath(user, "/api/admin/users/1", "PATCH"), false);
  assert.equal(canAccessPath(user, "/api/sales-partners/1/set-credentials", "POST"), false);
  assert.equal(canAccessPath(user, "/api/admin/providers/1", "POST"), false);
  assert.equal(canAccessPath(user, "/api/sync/migrate", "POST"), false);
  assert.equal(canAccessPath(user, "/api/logistica/carriers", "GET"), false);
  assert.equal(canAccessPath(user, "/api/generators/price-list-settings", "PUT"), true);
  assert.equal(canAccessPath({ moduleAccess: ["logistica-nacional"] }, "/api/logistica/shipments", "GET"), true);
  assert.equal(canAccessPath({ level: "ceo" }, "/api/employees/1", "PATCH"), true);
  assert.deepEqual(safeUser({ id: 4, password: "x", passwordHash: "y" }), { id: 4 });
});
