import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import Database from "@tauri-apps/plugin-sql";
import type {
  BatchSummary,
  ClientGroupOverride,
  StorageBridgeRequest,
  StoredRecord,
} from "./analytics.types";

type StoreName = "batches" | "records";
type Snapshot = {
  format: "app-descarga-backup";
  version: 1;
  exportedAt: string;
  batches: BatchSummary[];
  records: StoredRecord[];
  clientGroupOverrides?: ClientGroupOverride;
};

interface Repository {
  getAll<T>(storeName: StoreName): Promise<T[]>;
  import(batch: BatchSummary, records: StoredRecord[]): Promise<void>;
  approve(batchId: string, approvedAt: string): Promise<void>;
  updateReimbursements(records: Array<Pick<StoredRecord, "fingerprint" | "reimbursement">>): Promise<void>;
  updateCostCenters(records: Array<Pick<StoredRecord, "fingerprint" | "costCenter">>): Promise<void>;
  updateFinancials(records: Array<Pick<StoredRecord, "fingerprint" | "receivedValue" | "financialStatus">>): Promise<void>;
  replaceAll(batches: BatchSummary[], records: StoredRecord[]): Promise<void>;
}

const DB_NAME = "descarga-local-v1";
const DB_VERSION = 3;

const requestValue = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Falha no banco de dados local."));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("Falha ao salvar no banco local."));
  transaction.onabort = () => reject(transaction.error ?? new Error("Operação cancelada no banco local."));
});

class IndexedDbRepository implements Repository {
  private database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("batches")) db.createObjectStore("batches", { keyPath: "id" });
      if (!db.objectStoreNames.contains("records")) {
        const records = db.createObjectStore("records", { keyPath: "id" });
        records.createIndex("batchId", "batchId", { unique: false });
        records.createIndex("fingerprint", "fingerprint", { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Não foi possível abrir o banco local."));
  });

  async getAll<T>(storeName: StoreName) {
    const db = await this.database;
    const values = await requestValue(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
    return (storeName === "records"
      ? values.map((record) => ({ ...record, costCenter: record.costCenter ?? "",
          documentType: record.documentType ?? "",
          receivedValue: record.receivedValue ?? null, financialStatus: record.financialStatus ?? "not-informed",
          reimbursement: record.reimbursement ?? "not-informed" }))
      : values) as T[];
  }

  async import(batch: BatchSummary, records: StoredRecord[]) {
    const db = await this.database;
    const transaction = db.transaction(["batches", "records"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("batches").add(batch);
    const recordStore = transaction.objectStore("records");
    records.forEach((record) => recordStore.add(record));
    await done;
  }

  async approve(batchId: string, approvedAt: string) {
    const db = await this.database;
    const transaction = db.transaction("batches", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("batches");
    const batch = await requestValue<BatchSummary | undefined>(store.get(batchId));
    if (!batch) throw new Error("Lote não encontrado.");
    store.put({ ...batch, status: "approved", approvedAt });
    await done;
  }

  async updateReimbursements(records: Array<Pick<StoredRecord, "fingerprint" | "reimbursement">>) {
    const db = await this.database;
    const current = await this.getAll<StoredRecord>("records");
    const updates = new Map(records.map((record) => [record.fingerprint, record.reimbursement]));
    const transaction = db.transaction("records", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("records");
    current.forEach((record) => {
      const reimbursement = updates.get(record.fingerprint);
      if (reimbursement) store.put({ ...record, reimbursement });
    });
    await done;
  }

  async updateCostCenters(records: Array<Pick<StoredRecord, "fingerprint" | "costCenter">>) {
    const db = await this.database;
    const current = await this.getAll<StoredRecord>("records");
    const updates = new Map(records.map((record) => [record.fingerprint, record.costCenter]));
    const transaction = db.transaction("records", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("records");
    current.forEach((record) => {
      const costCenter = updates.get(record.fingerprint);
      if (costCenter !== undefined) store.put({ ...record, costCenter });
    });
    await done;
  }

  async updateFinancials(records: Array<Pick<StoredRecord, "fingerprint" | "receivedValue" | "financialStatus">>) {
    const db = await this.database;
    const current = await this.getAll<StoredRecord>("records");
    const updates = new Map(records.map((record) => [record.fingerprint, record]));
    const transaction = db.transaction("records", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("records");
    current.forEach((record) => {
      const update = updates.get(record.fingerprint);
      if (update) store.put({ ...record, receivedValue: update.receivedValue, financialStatus: update.financialStatus });
    });
    await done;
  }

  async replaceAll(batches: BatchSummary[], records: StoredRecord[]) {
    const db = await this.database;
    const transaction = db.transaction(["batches", "records"], "readwrite");
    const done = transactionDone(transaction);
    const batchStore = transaction.objectStore("batches");
    const recordStore = transaction.objectStore("records");
    batchStore.clear();
    recordStore.clear();
    batches.forEach((batch) => batchStore.add(batch));
    records.forEach((record) => recordStore.add(record));
    await done;
  }
}

type SqlRow = Record<string, string | number | null>;

const asBatch = (row: SqlRow): BatchSummary => ({
  id: String(row.id),
  name: String(row.name),
  fileName: String(row.file_name),
  periodicity: String(row.periodicity) as BatchSummary["periodicity"],
  periodStart: String(row.period_start),
  periodEnd: String(row.period_end),
  status: String(row.status) as BatchSummary["status"],
  rowCount: Number(row.row_count),
  duplicateCount: Number(row.duplicate_count),
  outOfPeriodCount: Number(row.out_of_period_count),
  importedAt: String(row.imported_at),
  ...(row.approved_at ? { approvedAt: String(row.approved_at) } : {}),
  ruleVersion: "v1",
});

const asRecord = (row: SqlRow): StoredRecord => ({
  id: String(row.id),
  batchId: String(row.batch_id),
  fingerprint: String(row.fingerprint),
  eventDate: String(row.event_date),
  branch: String(row.branch),
  documentType: String(row.document_type ?? ""),
  process: String(row.process),
  costCenter: String(row.cost_center ?? ""),
  clientCode: String(row.client_code),
  clientName: String(row.client_name),
  destinationCode: String(row.destination_code),
  destinationName: String(row.destination_name),
  weight: Number(row.weight),
  value: Number(row.value),
  receivedValue: row.received_value === null || row.received_value === undefined ? null : Number(row.received_value),
  financialStatus: (row.financial_status || "not-informed") as StoredRecord["financialStatus"],
  reimbursement: (row.reimbursement || "not-informed") as StoredRecord["reimbursement"],
});

class SqliteRepository implements Repository {
  private database = Database.load("sqlite:descarga.db").then(async (database) => {
    await database.execute(
      `DELETE FROM batches
       WHERE row_count <> (SELECT COUNT(*) FROM records WHERE records.batch_id = batches.id)`,
    );
    await database.execute("DELETE FROM records WHERE batch_id NOT IN (SELECT id FROM batches)");
    return database;
  });

  private async db() {
    return this.database;
  }

  async getAll<T>(storeName: StoreName) {
    const database = await this.db();
    const rows = storeName === "batches"
      ? await database.select<SqlRow[]>("SELECT * FROM batches")
      : await database.select<SqlRow[]>("SELECT * FROM records");
    return rows.map((row) => storeName === "batches" ? asBatch(row) : asRecord(row)) as T[];
  }

  private async insertBatch(batch: BatchSummary) {
    const database = await this.db();
    await database.execute(
      `INSERT INTO batches
       (id, name, file_name, periodicity, period_start, period_end, status, row_count,
        duplicate_count, out_of_period_count, imported_at, approved_at, rule_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batch.id, batch.name, batch.fileName, batch.periodicity, batch.periodStart, batch.periodEnd,
        batch.status, batch.rowCount, batch.duplicateCount, batch.outOfPeriodCount, batch.importedAt,
        batch.approvedAt ?? null, batch.ruleVersion],
    );
  }

  private async insertRecords(records: StoredRecord[]) {
    const database = await this.db();
    for (let offset = 0; offset < records.length; offset += 100) {
      const chunk = records.slice(offset, offset + 100);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
      const values = chunk.flatMap((record) => [record.id, record.batchId, record.fingerprint,
        record.eventDate, record.branch, record.documentType, record.process, record.costCenter, record.clientCode, record.clientName,
        record.destinationCode, record.destinationName, record.weight, record.value, record.receivedValue,
        record.financialStatus,
        record.reimbursement ?? "not-informed"]);
      await database.execute(
        `INSERT INTO records
         (id, batch_id, fingerprint, event_date, branch, document_type, process, cost_center, client_code, client_name,
          destination_code, destination_name, weight, value, received_value, financial_status, reimbursement) VALUES ${placeholders}`,
        values,
      );
    }
  }

  async import(batch: BatchSummary, records: StoredRecord[]) {
    const database = await this.db();
    try {
      await this.insertBatch(batch);
      await this.insertRecords(records);
    } catch (error) {
      await database.execute("DELETE FROM records WHERE batch_id = ?", [batch.id]);
      await database.execute("DELETE FROM batches WHERE id = ?", [batch.id]);
      throw error;
    }
  }

  async approve(batchId: string, approvedAt: string) {
    const database = await this.db();
    const result = await database.execute(
      "UPDATE batches SET status = 'approved', approved_at = ? WHERE id = ?",
      [approvedAt, batchId],
    );
    if (!result.rowsAffected) throw new Error("Lote não encontrado.");
  }

  async updateReimbursements(records: Array<Pick<StoredRecord, "fingerprint" | "reimbursement">>) {
    const database = await this.db();
    for (let offset = 0; offset < records.length; offset += 100) {
      const chunk = records.slice(offset, offset + 100);
      const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const fingerprints = chunk.map(() => "?").join(",");
      const values = chunk.flatMap((record) => [record.fingerprint, record.reimbursement]);
      await database.execute(
        `UPDATE records SET reimbursement = CASE fingerprint ${cases} ELSE reimbursement END
         WHERE fingerprint IN (${fingerprints})`,
        [...values, ...chunk.map((record) => record.fingerprint)],
      );
    }
  }

  async updateCostCenters(records: Array<Pick<StoredRecord, "fingerprint" | "costCenter">>) {
    const database = await this.db();
    for (let offset = 0; offset < records.length; offset += 100) {
      const chunk = records.slice(offset, offset + 100);
      const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const fingerprints = chunk.map(() => "?").join(",");
      const values = chunk.flatMap((record) => [record.fingerprint, record.costCenter]);
      await database.execute(
        `UPDATE records SET cost_center = CASE fingerprint ${cases} ELSE cost_center END
         WHERE fingerprint IN (${fingerprints})`,
        [...values, ...chunk.map((record) => record.fingerprint)],
      );
    }
  }

  async updateFinancials(records: Array<Pick<StoredRecord, "fingerprint" | "receivedValue" | "financialStatus">>) {
    const database = await this.db();
    for (let offset = 0; offset < records.length; offset += 100) {
      const chunk = records.slice(offset, offset + 100);
      const casesReceived = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const casesStatus = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const fingerprints = chunk.map(() => "?").join(",");
      const receivedValues = chunk.flatMap((record) => [record.fingerprint, record.receivedValue]);
      const statusValues = chunk.flatMap((record) => [record.fingerprint, record.financialStatus]);
      await database.execute(
        `UPDATE records SET
           received_value = CASE fingerprint ${casesReceived} ELSE received_value END,
           financial_status = CASE fingerprint ${casesStatus} ELSE financial_status END
         WHERE fingerprint IN (${fingerprints})`,
        [...receivedValues, ...statusValues, ...chunk.map((record) => record.fingerprint)],
      );
    }
  }

  async replaceAll(batches: BatchSummary[], records: StoredRecord[]) {
    const database = await this.db();
    await database.execute("DELETE FROM records");
    await database.execute("DELETE FROM batches");
    try {
      for (const batch of batches) await this.insertBatch(batch);
      await this.insertRecords(records);
    } catch (error) {
      await database.execute("DELETE FROM records");
      await database.execute("DELETE FROM batches");
      throw error;
    }
  }
}

const repository: Repository = isTauri() ? new SqliteRepository() : new IndexedDbRepository();

export const storageMode = isTauri() ? "SQLite local" : "IndexedDB do navegador";

export async function handleStorageRequest(request: StorageBridgeRequest): Promise<unknown> {
  if (request.operation === "getAll") return repository.getAll(request.storeName);
  if (request.operation === "import") return repository.import(request.batch, request.records);
  if (request.operation === "updateReimbursements") return repository.updateReimbursements(request.records);
  if (request.operation === "updateCostCenters") return repository.updateCostCenters(request.records);
  if (request.operation === "updateFinancials") return repository.updateFinancials(request.records);
  return repository.approve(request.batchId, request.approvedAt);
}

const validateSnapshot = (value: unknown): Snapshot => {
  if (!value || typeof value !== "object") throw new Error("O arquivo de backup é inválido.");
  const snapshot = value as Partial<Snapshot>;
  if (snapshot.format !== "app-descarga-backup" || snapshot.version !== 1
    || !Array.isArray(snapshot.batches) || !Array.isArray(snapshot.records)) {
    throw new Error("O arquivo não é um backup compatível do APP Descarga.");
  }
  return snapshot as Snapshot;
};

const buildSnapshot = async (): Promise<Snapshot> => ({
  format: "app-descarga-backup",
  version: 1,
  exportedAt: new Date().toISOString(),
  batches: await repository.getAll<BatchSummary>("batches"),
  records: await repository.getAll<StoredRecord>("records"),
  clientGroupOverrides: (() => {
    try { return JSON.parse(localStorage.getItem("app-descarga-client-group-overrides-v1") || "{}"); }
    catch { return {}; }
  })(),
});

export async function createBackup() {
  const contents = JSON.stringify(await buildSnapshot());
  const defaultName = `app-descarga-backup-${new Date().toISOString().slice(0, 10)}.json`;
  if (isTauri()) {
    const destination = await save({ defaultPath: defaultName, filters: [{ name: "Backup APP Descarga", extensions: ["json"] }] });
    if (!destination) return false;
    await writeTextFile(destination, contents);
    return true;
  }
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultName;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

const chooseBrowserBackup = () => new Promise<string | null>((resolve, reject) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    try { resolve(input.files?.[0] ? await input.files[0].text() : null); }
    catch (error) { reject(error); }
  };
  input.click();
});

export async function restoreBackup() {
  const contents = isTauri()
    ? await (async () => {
        const source = await open({ multiple: false, directory: false, filters: [{ name: "Backup APP Descarga", extensions: ["json"] }] });
        return source ? readTextFile(source) : null;
      })()
    : await chooseBrowserBackup();
  if (!contents) return false;
  const snapshot = validateSnapshot(JSON.parse(contents));
  await repository.replaceAll(snapshot.batches, snapshot.records.map((record) => ({
    ...record,
    costCenter: record.costCenter ?? "",
    documentType: record.documentType ?? "",
    receivedValue: record.receivedValue ?? null,
    financialStatus: record.financialStatus ?? "not-informed",
    reimbursement: record.reimbursement ?? "not-informed",
  })));
  localStorage.setItem("app-descarga-client-group-overrides-v1", JSON.stringify(snapshot.clientGroupOverrides ?? {}));
  localStorage.removeItem("app-descarga-reimbursement-backfill-v1");
  localStorage.removeItem("app-descarga-cost-center-backfill-v1");
  localStorage.removeItem("app-descarga-financial-backfill-v1");
  return true;
}
