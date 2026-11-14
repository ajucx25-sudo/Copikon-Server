import { parentPort, workerData } from "node:worker_threads";
import { cleanBrief, createPackagePdf } from "./baifa-sales-documents.js";
try {
  const fn = workerData.task === "brief" ? cleanBrief : createPackagePdf;
  parentPort.postMessage({ value: await fn(...workerData.args) });
} catch (e) {
  parentPort.postMessage({ error: e.status ? e.message : "No se pudo leer el PDF. Exporta una copia válida sin protección.", status: e.status || 400 });
}
