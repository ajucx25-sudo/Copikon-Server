// In-memory test database: no network or real customer data.
const kv = new Map([
  ["employees", [
    {id:1,username:"qa-admin",level:"ceo",password:"test-only-password",status:"active"},
    {id:2,username:"qa-sales",level:"employee",password:"test-only-password",moduleAccess:["generators-ventas"],status:"active"},
    {id:3,username:"qa-logistics",level:"employee",password:"test-only-password",moduleAccess:["logistica-nacional"],status:"active"},
    {id:4,username:"qa-coordinator",level:"coordinador",password:"test-only-password",moduleAccess:["generators-posventa"],status:"active"},
  ]],
  ["logisticaCarriers",[{id:1,name:"Fictional carrier"}]],
  ["erpClients",[{id:501,name:"QA client",odooId:771,phone:"123",status:"activo"}]],
  ["erpClientEquipment",[
    {id:601,clientId:501,model:"QA",source:"venta",serial:"QA-601",active:true},
    {id:602,clientId:501,model:"QA other",source:"venta",active:true},
    {id:603,source:"externo",active:true},
    {id:604,source:"venta",active:false},
  ]],
]);
const sessions=new Map();
class Pool {
  async query(sql,args=[]) {
    if (/INSERT INTO secure_sessions/.test(sql)) sessions.set(args[0],{subject:args[1],credential_digest:args[2],expires_at:args[3]});
    if (/DELETE FROM secure_sessions WHERE token_hash/.test(sql)) sessions.delete(args[0]);
    if (/SELECT .* FROM secure_sessions/.test(sql)) return {rows:sessions.has(args[0])?[sessions.get(args[0])]:[]};
    if (/SELECT value FROM kv/.test(sql)) return {rows:kv.has(args[0])?[{value:structuredClone(kv.get(args[0]))}]:[]};
    if (/INSERT INTO kv/.test(sql)) kv.set(args[0],JSON.parse(args[1]));
    return {rows:[]};
  }
  async connect(){return this;}
  release(){}
}
export default {Pool};
