# Copikon — Servidor compartido

Backend ligero (Express + Postgres) que reemplaza el mock que la intranet usaba
en el navegador. Todos los usuarios escriben/leen contra la misma base de datos.

## Estructura

- `server.js` — servidor Express. Una sola tabla `kv` en Postgres con JSONB por
  colección (employees, projects, projectTasks, erpProducts, etc.).
- `render.yaml` — config para desplegar en Render.com con Postgres free.

## Cómo desplegar en Render.com (5 minutos)

1. Crea una cuenta gratis en https://render.com (con tu Google o GitHub).
2. En el dashboard, **New → Blueprint** → conecta este repo (o sube el zip).
   Render lee `render.yaml` automáticamente.
3. Espera el primer deploy (~3 min). Vas a recibir una URL del tipo
   `https://copikon-server-XXXX.onrender.com`.
4. Visita `https://copikon-server-XXXX.onrender.com/api/health` — debe
   responder `{ "ok": true, ... }`.
5. En la intranet (Settings o el banner que aparecerá), pega esa URL para
   conectar la app al servidor compartido.

> El plan **free** de Render duerme el servicio tras 15 min de inactividad.
> La primera petición lo despierta en ~30 segundos. Para producción seria,
> pasa al plan Starter ($7/mes).

## Endpoints

- `GET  /api/health` — keep-alive
- `POST /api/auth/login` — body `{username, password}` → `{token, user}`
- `GET  /api/auth/me` — header `Authorization: Bearer <token>`
- CRUD genérico para cada colección (lista abajo):
  - `GET    /api/<recurso>`           → array
  - `GET    /api/<recurso>/:id`       → objeto
  - `POST   /api/<recurso>`           → crea (asigna id)
  - `PATCH  /api/<recurso>/:id`       → merge parcial
  - `PUT    /api/<recurso>/:id`       → reemplazo
  - `DELETE /api/<recurso>/:id`       → borra
- `PUT  /api/salary-bands/by-employee` — upsert por employeeId
- `PATCH /api/admin/users/:id` — credenciales/permisos
- `POST /api/sync/migrate` — body `{snapshot, mode:"merge"|"replace"}`
  Usado **una sola vez** por la intranet para subir el IndexedDB local del
  usuario al servidor.
- `POST /api/sync/seed` — body `{seed}` — solo escribe colecciones vacías.

### Recursos disponibles

employees, projects, project-tasks, copikon-gen-activities, erp/clients,
erp/suppliers, erp/products, erp/quotes, erp/invoices, erp/purchase-orders,
erp/service-orders, erp/dispatches, erp/visits, erp/contracts, erp/leads,
erp/reservations, salary-bands, erp/price-bands, erp/rental-contracts,
erp/rental-payments.

### Módulo Playbooks Comerciales (`playbooks.js`)

Seguimiento de KPIs para campañas de venta desde Comercialización. Trae
ventas reales desde Odoo (`sale.order.line`) filtradas por SKU + fecha +
almacén, calcula avance vs meta, ritmo, cobertura, ranking y comisiones,
y persiste snapshots en `kv`.

Endpoints:

- `GET  /api/playbooks` — lista todos los playbooks
- `GET  /api/playbooks/:id` — config completa
- `POST /api/playbooks` — crear (id string requerido)
- `PATCH /api/playbooks/:id` — actualizar
- `DELETE /api/playbooks/:id` — borrar
- `POST /api/playbooks/:id/sync` — sincroniza ventas desde Odoo
- `POST /api/playbooks/sync-all` — sync masivo (uso con cron)
- `GET  /api/playbooks/:id/snapshot` — snapshot completo (KPIs + daily + leaderboard + cobertura)
- `GET  /api/playbooks/:id/kpis` — solo KPIs (payload liviano)
- `GET  /api/playbooks/:id/daily` — serie diaria (para gráfico)
- `GET  /api/playbooks/:id/leaderboard` — ranking de vendedores
- `GET  /api/playbooks/:id/sku-coverage` — cobertura por SKU
- `GET  /api/playbooks/:id/commissions?month=YYYY-MM` — cálculo de comisiones

Seed automático al arranque (solo si la colección `playbooks` está vacía):

- `stanley-40oz-bto-2026q3` — Vasos Stanley 40oz Barquisimeto (1900 uds)
- `conos-seguridad-bto-2026q3` — Conos PVC TRAFFCONE Barquisimeto (1900 uds)

## Desarrollo local

```bash
npm install
npm start    # http://localhost:5050
```
