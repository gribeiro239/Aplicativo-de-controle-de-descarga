import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const databasePath = join(process.env.APPDATA, "br.com.appdescarga.desktop", "descarga.db");
const database = new DatabaseSync(databasePath, { readOnly: true });
const total = database.prepare("SELECT COUNT(1) AS count FROM records").get();
const all = database.prepare(
  "SELECT reimbursement, COUNT(1) AS count FROM records GROUP BY reimbursement ORDER BY count DESC",
).all();
const selectedPair = database.prepare(
  `SELECT reimbursement, COUNT(1) AS count
   FROM records
   WHERE client_name LIKE ? AND destination_name LIKE ?
   GROUP BY reimbursement`,
).all("%ALIMENTOS WILSON%", "%BOM DIA COM ALIM%");
database.close();

const json = JSON.stringify({ total, all, selectedPair }, (_, value) =>
  typeof value === "bigint" ? Number(value) : value, 2);
console.log(json);
