import test from "node:test";
import assert from "node:assert/strict";
import { isClientMutation, validateClientEdit } from "./client-edit-access.js";
import { canAccessPath } from "./secure-access.js";

test("only updates and deletion enter the client mutation policy", () => {
  for (const method of ["PATCH","PUT","DELETE"]) assert.ok(isClientMutation("/API/ERP/CLIENTS/501",method));
  for (const method of ["GET","POST","OPTIONS"]) assert.equal(isClientMutation("/api/erp/clients/501",method),false);
  assert.equal(isClientMutation("/api/erp/client-equipment/501","PATCH"),false);
});
test("trusted roles only, never partner overrides", () => {
  for (const user of [{level:"ceo"},{username:"admin"},{level:"coordinador"}]) {
    assert.ok(canAccessPath(user,"/api/erp/clients/1","PATCH"));
  }
  for (const user of [{}, {level:"vendedor"}, {level:"tecnico"}, {level:"coordinador",isPartner:true}]) {
    assert.equal(canAccessPath(user,"/api/erp/clients/1","PATCH"),false);
  }
});
test("allowlisted bounded fields only and explicit null clearing", () => {
  assert.deepEqual(validateClientEdit({name:" New ",email:"",phone:null}),{patch:{name:"New",email:null,phone:null}});
  for (const input of [null,[],{}, {id:2}, {odooId:8}, {__proto__:null,constructor:"x"}, {name:null}, {email:"bad"}, {phone:{}}, {city:"x".repeat(101)}]) {
    assert.ok(validateClientEdit(input).error);
  }
});
