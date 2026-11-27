import test from "node:test";import assert from "node:assert/strict";import {welcomeSpecs} from "./posventa-welcome.js";
test("La potencia y modelo se toman de la descripción de la unidad del cliente, no del número del modelo",()=>{
 const entry={id:1,unit:"u"},unit={id:1,clientId:2,odooUnitKey:"u",productDescription:"Modelo: BF-C220S-60. 60 Hz / 1800 RPM. En espera 250 kVA."};
 assert.deepEqual(welcomeSpecs(unit,entry,2),{model:"BF-C220S-60",powerKva:250});
 assert.deepEqual(welcomeSpecs(unit,entry,3),{});assert.deepEqual(welcomeSpecs(unit,{...entry,unit:"otra"},2),{});
 for(const productDescription of ["BF-C220S-60","250/275 kVA","250 kVA y 275 kVA","1.500 kVA","1,500 kVA","1 500 kVA",""])assert.equal(welcomeSpecs({...unit,productDescription},entry,2).powerKva,undefined);
});
