import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const databasePath = join(process.env.APPDATA, "br.com.appdescarga.desktop", "descarga.db");
const database = new DatabaseSync(databasePath, { readOnly: true });
const target = database.prepare(
  "SELECT * FROM records WHERE process = ? ORDER BY event_date DESC LIMIT 1",
).get("10491");

if (!target) throw new Error("Processo 10491 não encontrado.");

const records = database.prepare(
  `SELECT records.* FROM records
   JOIN batches ON batches.id = records.batch_id
   WHERE batches.status = 'approved'`,
).all();
const cutoff = new Date(`${target.event_date}T00:00:00Z`);
cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
const cutoffDate = cutoff.toISOString().slice(0, 10);
const recent = (source) => source
  .filter((record) => record.event_date >= cutoffDate && record.event_date < target.event_date)
  .sort((left, right) => right.event_date.localeCompare(left.event_date))
  .slice(0, 20);
const recentExact = recent(records.filter((record) =>
  record.client_code === target.client_code && record.destination_code === target.destination_code));
const recentDestination = recent(records.filter((record) => record.destination_code === target.destination_code));
const recentClient = recent(records.filter((record) => record.client_code === target.client_code));
const historicalExact = records
  .filter((record) => record.client_code === target.client_code
    && record.destination_code === target.destination_code
    && record.event_date < target.event_date)
  .sort((left, right) => left.event_date.localeCompare(right.event_date))
  .slice(-20);

const chosen = recentExact.length >= 3
  ? { name: "cliente + destinatário", rows: recentExact }
  : { name: "cliente + destinatário, incluindo histórico anterior", rows: historicalExact };
const values = chosen.rows.map((row) => Number(row.value)).sort((left, right) => left - right);
const middle = Math.floor(values.length / 2);
const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;

console.log(JSON.stringify({
  target: { eventDate: target.event_date, process: target.process, value: target.value,
    clientCode: target.client_code, destinationCode: target.destination_code },
  cohortCounts: { recentExact: recentExact.length, recentDestination: recentDestination.length,
    recentClient: recentClient.length, historicalExact: historicalExact.length },
  chosenCohort: chosen.name,
  sufficient: chosen.rows.length >= 3,
  orderedValues: values,
  centralValues: values.length % 2 ? [values[middle]] : [values[middle - 1], values[middle]],
  median,
}, null, 2));
database.close();
