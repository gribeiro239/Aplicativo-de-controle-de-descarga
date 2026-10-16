/// <reference lib="webworker" />
import * as XLSX from "xlsx";
import type {
  AnalysisResult,
  BatchAnalysisResult,
  BatchSummary,
  CatalogItem,
  ClientGroupOverride,
  ClientGroupSummary,
  Confidence,
  DashboardSummary,
  FinancialOutcome,
  FinancialSummary,
  HistoryScope,
  HistoricalInsights,
  ManualRecordInput,
  Periodicity,
  RuleResult,
  StorageBridgeResponse,
  Status,
  StoredRecord,
  WorkerRequest,
  WorkerResponse,
} from "./analytics.types";
import { isInWeightBand, WEIGHT_BANDS, weightBandFor } from "./weight-bands";

const BATCH_STORE = "batches";
const RECORD_STORE = "records";

type BridgePending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const bridgePending = new Map<number, BridgePending>();
let bridgeRequestId = 0;

const storageCall = <T,>(request: Record<string, unknown>) => new Promise<T>((resolve, reject) => {
  const bridgeId = ++bridgeRequestId;
  bridgePending.set(bridgeId, { resolve: (value) => resolve(value as T), reject });
  self.postMessage({ bridge: "storage-request", bridgeId, ...request });
});

async function getAll<T>(storeName: string): Promise<T[]> {
  return storageCall<T[]>({ operation: "getAll", storeName });
}

const asText = (value: unknown) => String(value ?? "").trim();
const asNumber = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = asText(value);
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(/,(?=[^,]*$)/, ".").replace(/,/g, "")
    : raw;
  const parsed = Number(normalized.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const asOptionalNumber = (value: unknown) => asText(value) === "" ? null : asNumber(value);
const normalizeHeader = (value: unknown) => asText(value)
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

const normalizedClientName = (value: unknown) => normalizeHeader(value)
  .replace(/&/g, " E ")
  .replace(/[^A-Z0-9]+/g, " ")
  .replace(/\b(LTDA|LIMITADA|S A|SA|ME|EPP|EIRELI)\b/g, " ")
  .replace(/\s+/g, " ").trim();

let clientGroupOverrides: ClientGroupOverride = {};
const clientAliasKey = (record: Pick<StoredRecord, "clientCode" | "clientName">) =>
  `${record.clientCode}|${normalizedClientName(record.clientName)}`;
const groupCodeFor = (name: string) => normalizeHeader(name).toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const clientGroup = (record: Pick<StoredRecord, "clientCode" | "clientName">): CatalogItem => {
  const normalized = normalizedClientName(record.clientName) || normalizedClientName(record.clientCode);
  const consolidated = [
    { pattern: /\bNINFA\b/, name: "NINFA" },
    { pattern: /\bYOKI\b/, name: "YOKI" },
  ].find(({ pattern }) => pattern.test(normalized));
  if (consolidated) return { code: groupCodeFor(consolidated.name), name: consolidated.name };
  const overridden = clientGroupOverrides[clientAliasKey(record)];
  if (overridden) return overridden;
  const known: Array<[RegExp, string]> = [
    [/\bNESTLE\b/, "NESTLÉ"],
    [/\bDANONE\b/, "DANONE"],
    [/\bMARILAN\b/, "MARILAN"],
    [/\bDORI\b/, "DORI ALIMENTOS"],
    [/^CRM\b/, "CRM"],
    [/^EMPRESA BRASILEIRA DE BEBIDAS E ALIM(?:ENTOS)?\b/, "EMPRESA BRASILEIRA DE BEBIDAS E ALIMENTOS"],
  ];
  const matched = known.find(([pattern]) => pattern.test(normalized));
  const name = matched?.[1] ?? normalized;
  return { code: groupCodeFor(name), name };
};
const asReimbursement = (value: unknown): StoredRecord["reimbursement"] => {
  const normalized = normalizeHeader(value).replace(/[^A-Z]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized === "REEMBOLSAVEL") return "reimbursable";
  if (normalized === "NAO REEMBOLSAVEL") return "non-reimbursable";
  if (normalized === "INCLUSO NO FRETE") return "included-in-freight";
  return "not-informed";
};
const asFinancialStatus = (value: unknown): StoredRecord["financialStatus"] => {
  const normalized = normalizeHeader(value).replace(/[^A-Z]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized === "COBRADO") return "charged";
  if (normalized === "PREJUIZO") return "loss";
  if (normalized === "NAO TRATADO") return "untreated";
  return normalized ? "other" : "not-informed";
};
const datePart = (value: Date) => {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const asDate = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return datePart(value);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const raw = asText(value);
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})/);
  if (br) return `${br[3].length === 2 ? `20${br[3]}` : br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : "";
};

function parseRows(buffer: ArrayBuffer, batchId: string): StoredRecord[] {
  const workbook = XLSX.read(buffer, { type: "array", dense: true, cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("O arquivo não possui uma planilha legível.");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: false, raw: true });
  if (!matrix.length) throw new Error("A planilha está vazia.");
  const headers = matrix[0].map(normalizeHeader);
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const indexes = {
    date: column("DATA", "DATA DESCARGA"),
    branch: column("FIL", "FILIAL"),
    documentType: column("TIPO"),
    process: column("PROC.", "PROC", "PROCESSO"),
    costCenter: column("C.C", "CC", "CENTRO DE CUSTO"),
    clientCode: column("COD_CLI", "COD CLI"),
    clientName: column("CLIENTE"),
    destinationCode: column("COD_DES", "COD DES"),
    destinationName: column("DESTINATARIO"),
    weight: column("PESO"),
    value: column("VALOR"),
    receivedValue: column("VLR RECEBIDO", "VALOR RECEBIDO"),
    financialStatus: column("STATUS"),
    reimbursement: headers.findIndex((header) => header.startsWith("REEM")),
  };
  const missing = [
    [indexes.date, "DATA"], [indexes.clientCode, "COD_CLI"],
    [indexes.destinationCode, "COD_DES"], [indexes.value, "VALOR"],
  ].filter(([index]) => Number(index) < 0).map(([, name]) => name);
  if (missing.length) throw new Error(`Colunas obrigatórias não encontradas: ${missing.join(", ")}.`);

  const records: StoredRecord[] = [];
  for (const row of matrix.slice(1)) {
    const eventDate = asDate(row[indexes.date]);
    const branch = asText(row[indexes.branch]);
    const documentType = asText(row[indexes.documentType]);
    const process = asText(row[indexes.process]);
    const costCenter = asText(row[indexes.costCenter]);
    const clientCode = asText(row[indexes.clientCode]);
    const destinationCode = asText(row[indexes.destinationCode]);
    const weight = asNumber(row[indexes.weight]);
    const value = asNumber(row[indexes.value]);
    const receivedValue = asOptionalNumber(row[indexes.receivedValue]);
    if (!eventDate || !clientCode || !destinationCode || value <= 0) continue;
    const fallback = [eventDate, clientCode, destinationCode, weight.toFixed(3), value.toFixed(2)].join("|");
    const fingerprint = process ? `${branch || "_"}|${process}` : fallback;
    records.push({
      id: `${batchId}:${fingerprint}`,
      batchId,
      fingerprint,
      eventDate,
      branch,
      documentType,
      process,
      costCenter,
      clientCode,
      clientName: asText(row[indexes.clientName]) || clientCode,
      destinationCode,
      destinationName: asText(row[indexes.destinationName]) || destinationCode,
      weight,
      value,
      receivedValue,
      financialStatus: asFinancialStatus(row[indexes.financialStatus]),
      reimbursement: asReimbursement(row[indexes.reimbursement]),
    });
  }
  if (!records.length) throw new Error("Nenhuma linha válida foi encontrada. Verifique DATA, cliente, destinatário e valor.");
  return records;
}

async function state() {
  const batches = (await getAll<BatchSummary>(BATCH_STORE))
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart) || b.importedAt.localeCompare(a.importedAt));
  const records = await getAll<StoredRecord>(RECORD_STORE);
  const approved = new Set(batches.filter((batch) => batch.status === "approved").map((batch) => batch.id));
  const historical = records.filter((record) => approved.has(record.batchId));
  const summary: DashboardSummary = {
    historicalRowCount: historical.length,
    clientCount: new Set(historical.map((record) => clientGroup(record).code)).size,
    destinationCount: new Set(historical.map((record) => record.destinationCode)).size,
    pendingBatchCount: batches.filter((batch) => batch.status === "pending").length,
  };
  return { summary, batches };
}

async function importBatch(request: Extract<WorkerRequest, { type: "import" }>) {
  const batchId = crypto.randomUUID();
  const parsed = parseRows(request.buffer, batchId);
  return persistBatch(request, batchId, parsed);
}

function parseManualRecords(rows: ManualRecordInput[], batchId: string): StoredRecord[] {
  if (!rows.length) throw new Error("Adicione pelo menos um registro ao lote manual.");
  return rows.map((row, index) => {
    const eventDate = asDate(row.eventDate);
    const branch = asText(row.branch);
    const documentType = asText(row.documentType);
    const process = asText(row.process);
    const costCenter = asText(row.costCenter);
    const clientCode = asText(row.clientCode);
    const destinationCode = asText(row.destinationCode);
    const weight = asNumber(row.weight);
    const value = asNumber(row.value);
    if (!eventDate || !clientCode || !destinationCode || value <= 0) {
      throw new Error(`Linha ${index + 1}: informe data, código do cliente, código do destinatário e valor maior que zero.`);
    }
    const fallback = [eventDate, clientCode, destinationCode, weight.toFixed(3), value.toFixed(2)].join("|");
    const fingerprint = process ? `${branch || "_"}|${process}` : fallback;
    return {
      id: `${batchId}:${fingerprint}`,
      batchId,
      fingerprint,
      eventDate,
      branch,
      documentType,
      process,
      costCenter,
      clientCode,
      clientName: asText(row.clientName) || clientCode,
      destinationCode,
      destinationName: asText(row.destinationName) || destinationCode,
      weight,
      value,
      receivedValue: null,
      financialStatus: "not-informed",
      reimbursement: row.reimbursement,
    };
  });
}

type PendingImport = {
  name: string;
  periodicity: Periodicity;
  periodStart?: string;
  periodEnd?: string;
  status?: BatchSummary["status"];
  fileName?: string;
};

async function persistBatch(request: PendingImport, batchId: string, parsed: StoredRecord[]) {
  const existing = new Set((await getAll<StoredRecord>(RECORD_STORE)).map((record) => record.fingerprint));
  const withinFile = new Set<string>();
  const accepted = parsed.filter((record) => {
    if (existing.has(record.fingerprint) || withinFile.has(record.fingerprint)) return false;
    withinFile.add(record.fingerprint);
    return true;
  });
  if (!accepted.length) throw new Error("Todos os registros deste arquivo já existem na base local.");
  const inferredStart = accepted.reduce((min, record) => record.eventDate < min ? record.eventDate : min, accepted[0].eventDate);
  const inferredEnd = accepted.reduce((max, record) => record.eventDate > max ? record.eventDate : max, accepted[0].eventDate);
  const periodStart = request.periodStart || inferredStart;
  const periodEnd = request.periodEnd || inferredEnd;
  if (periodEnd < periodStart) throw new Error("A data final do período não pode ser anterior à data inicial.");
  const outOfPeriodCount = accepted.filter((record) => record.eventDate < periodStart || record.eventDate > periodEnd).length;
  const now = new Date().toISOString();
  const batch: BatchSummary = {
    id: batchId,
    name: request.name.trim() || request.fileName || "Lote manual",
    fileName: request.fileName || "Entrada manual",
    periodicity: request.periodicity,
    periodStart,
    periodEnd,
    status: request.status ?? "pending",
    rowCount: accepted.length,
    duplicateCount: parsed.length - accepted.length,
    outOfPeriodCount,
    importedAt: now,
    approvedAt: request.status === "approved" ? now : undefined,
    ruleVersion: "v1",
  };
  await storageCall<void>({ operation: "import", batch, records: accepted });
  return batch;
}

async function importManualBatch(request: Extract<WorkerRequest, { type: "manualImport" }>) {
  const batchId = crypto.randomUUID();
  return persistBatch(request, batchId, parseManualRecords(request.records, batchId));
}

const buildCatalog = (records: StoredRecord[], selectedGroup?: string, selectedCostCenter?: string) => {
  const clients = new Map<string, CatalogItem>();
  const costCenters = new Map<string, CatalogItem>();
  const destinations = new Map<string, CatalogItem>();
  records.forEach((record) => {
    const group = clientGroup(record);
    clients.set(group.code, group);
    if (!selectedGroup) {
      destinations.set(record.destinationCode, { code: record.destinationCode, name: record.destinationName });
    }
    if (selectedGroup && group.code === selectedGroup) {
      const code = record.costCenter || "__sem_cc__";
      costCenters.set(code, { code, name: record.costCenter || "Sem C.C informado" });
    }
    if (selectedGroup && selectedCostCenter && group.code === selectedGroup
      && (record.costCenter || "__sem_cc__") === selectedCostCenter) {
      destinations.set(record.destinationCode, { code: record.destinationCode, name: record.destinationName });
    }
  });
  const sort = (items: CatalogItem[]) => items.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { clients: sort([...clients.values()]), costCenters: sort([...costCenters.values()]),
    destinations: sort([...destinations.values()]) };
};

async function catalog(batchId: string, selectedGroup?: string, selectedCostCenter?: string) {
  const records = (await getAll<StoredRecord>(RECORD_STORE)).filter((record) => record.batchId === batchId);
  return buildCatalog(records, selectedGroup, selectedCostCenter);
}

async function approvedRecords() {
  const batches = await getAll<BatchSummary>(BATCH_STORE);
  const approved = new Set(batches.filter((batch) => batch.status === "approved").map((batch) => batch.id));
  return (await getAll<StoredRecord>(RECORD_STORE)).filter((record) => approved.has(record.batchId));
}

async function historyCatalog(selectedGroup?: string, selectedCostCenter?: string) {
  return buildCatalog(await approvedRecords(), selectedGroup, selectedCostCenter);
}

async function groupCatalog(): Promise<ClientGroupSummary[]> {
  const records = await approvedRecords();
  const groups = new Map<string, { item: CatalogItem; records: StoredRecord[] }>();
  records.forEach((record) => {
    const item = clientGroup(record);
    const current = groups.get(item.code) ?? { item, records: [] };
    current.records.push(record);
    groups.set(item.code, current);
  });
  return [...groups.values()].map(({ item, records: members }) => {
    const aliases = new Map<string, { code: string; name: string; count: number }>();
    members.forEach((record) => {
      const key = clientAliasKey(record);
      const alias = aliases.get(key) ?? { code: record.clientCode, name: record.clientName, count: 0 };
      alias.count += 1;
      aliases.set(key, alias);
    });
    return {
      ...item,
      recordCount: members.length,
      costCenterCount: new Set(members.map((record) => record.costCenter || "__sem_cc__")).size,
      aliases: [...aliases].map(([key, alias]) => ({ key, code: alias.code, name: alias.name,
        recordCount: alias.count })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

async function approve(batchId: string) {
  await storageCall<void>({ operation: "approve", batchId, approvedAt: new Date().toISOString() });
}

async function backfillReimbursement(buffer: ArrayBuffer) {
  const records = parseRows(buffer, "reimbursement-backfill").map(({ fingerprint, reimbursement }) => ({
    fingerprint,
    reimbursement,
  }));
  await storageCall<void>({ operation: "updateReimbursements", records });
  return records.length;
}

async function backfillCostCenters(buffer: ArrayBuffer) {
  const records = parseRows(buffer, "cost-center-backfill").map(({ fingerprint, costCenter }) => ({ fingerprint, costCenter }));
  await storageCall<void>({ operation: "updateCostCenters", records });
  return records.length;
}

async function backfillFinancials(buffer: ArrayBuffer) {
  const records = parseRows(buffer, "financial-backfill").map(({ fingerprint, receivedValue, financialStatus }) => ({
    fingerprint, receivedValue, financialStatus,
  }));
  await storageCall<void>({ operation: "updateFinancials", records });
  return records.length;
}

const medianOf = (source: number[]) => {
  if (!source.length) return 0;
  const values = [...source].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const confidenceFor = (count: number): Confidence =>
  count >= 8 ? "Alta" : count >= 5 ? "Média" : count >= 3 ? "Baixa" : "Insuficiente";

function evaluateRule(informedValue: number, records: StoredRecord[], explanation: string,
  confidenceLimit?: Exclude<Confidence, "Insuficiente">): RuleResult {
  const values = records.map((row) => row.value).filter((item) => item > 0);
  const median = medianOf(values);
  const count = values.length;
  const average = count ? values.reduce((sum, value) => sum + value, 0) / count : 0;
  const minimum = count ? Math.min(...values) : 0;
  const maximum = count ? Math.max(...values) : 0;
  const difference = median ? Math.round(((informedValue - median) / median) * 100) : 0;
  const mad = medianOf(values.map((item) => Math.abs(item - median)));
  if (count < 3 || !median) return { status: "insufficient", median, average, minimum, maximum, mad,
    lower: 0, upper: 0, difference, count, confidence: "Insuficiente", explanation };
  const tolerance = Math.min(.5, Math.max(.2, (mad * 1.4826) / median));
  // Valores abaixo da mediana representam um custo favorável e não devem gerar alerta.
  // A análise de valor é, portanto, unilateral: apenas o limite superior é restritivo.
  const lower = 0;
  const upper = median * (1 + tolerance);
  const extraTolerance = .2 * median;
  let status: Status = "expected";
  if (informedValue > upper) status = informedValue <= upper + extraTolerance ? "high" : "very-high";
  const order: Confidence[] = ["Insuficiente", "Baixa", "Média", "Alta"];
  const calculated = confidenceFor(count);
  const confidence = confidenceLimit
    ? order[Math.min(order.indexOf(calculated), order.indexOf(confidenceLimit))]
    : calculated;
  return { status, median, average, minimum, maximum, mad, lower, upper, difference, count, confidence, explanation };
}

const recordsInWeightBand = (records: StoredRecord[], weight: number) => {
  const band = weightBandFor(weight);
  return band ? { band, records: records.filter((row) => isInWeightBand(row.weight, band)) } : null;
};

const emptyWeightBandRule = (record: StoredRecord, scopeName: string) => evaluateRule(record.value, [],
  record.weight > 0 ? `${scopeName}; faixa de peso não identificada` : "Peso não informado");

const adherenceToMedian = (informedValue: number, rule: RuleResult) => {
  if (rule.count < 3 || rule.median <= 0) return null;
  const relativeExcess = Math.max(0, informedValue - rule.median) / rule.median;
  return Math.round(Math.max(0, 100 * (1 - relativeExcess)));
};

const confidenceScoreFor = (informedValue: number, bandRule: RuleResult) => {
  const valueScore = adherenceToMedian(informedValue, bandRule);
  const weightValueScore = null;
  const score = valueScore;
  const label = score === null ? "Histórico insuficiente" as const
    : score >= 85 ? "Alta" as const
    : score >= 70 ? "Moderada" as const
    : score >= 50 ? "Baixa" as const
    : "Muito baixa" as const;
  return { score, valueScore, weightValueScore, label };
};

function analyzeRecord(record: StoredRecord, history: StoredRecord[]): AnalysisResult {
  const groupCode = clientGroup(record).code;
  const exact = history.filter((item) => item.id !== record.id && clientGroup(item).code === groupCode
    && item.costCenter === record.costCenter && item.destinationCode === record.destinationCode);
  const cohort = recordsInWeightBand(exact, record.weight);
  const destinationRule = cohort
    ? evaluateRule(record.value, cohort.records,
      `mesmo grupo de cliente, C.C e destinatário; faixa ${cohort.band.label}`)
    : emptyWeightBandRule(record, "Mesmo grupo de cliente, C.C e destinatário");
  // Mantido no contrato por compatibilidade; a regra principal já incorpora a faixa de peso.
  const weightRule = destinationRule;
  const overallStatus = destinationRule.status;
  return { destinationName: record.destinationName, destinationRule, weightRule,
    confidenceScore: confidenceScoreFor(record.value, destinationRule), overallStatus };
}

const recentRecords = (records: StoredRecord[], beforeDate: string) => {
  const cutoff = new Date(`${beforeDate}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const cutoffDate = datePart(cutoff);
  return records.filter((item) => item.eventDate >= cutoffDate && item.eventDate < beforeDate)
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate)).slice(0, 20);
};

const matchesHistoryScope = (candidate: StoredRecord, record: StoredRecord, scope: HistoryScope) => {
  if (scope === "client") return clientGroup(candidate).code === clientGroup(record).code;
  if (scope === "destination") return candidate.destinationCode === record.destinationCode;
  return clientGroup(candidate).code === clientGroup(record).code
    && candidate.costCenter === record.costCenter && candidate.destinationCode === record.destinationCode;
};

const historyScopeName = (scope: HistoryScope) => scope === "client" ? "mesmo grupo de cliente"
  : scope === "destination" ? "mesmo destinatário" : "mesmo grupo de cliente, C.C e destinatário";

function analyzeHistoricalRecord(record: StoredRecord, history: StoredRecord[], scope: HistoryScope = "strict"): AnalysisResult {
  const scopeName = historyScopeName(scope);
  const exactAll = history.filter((item) => item.id !== record.id && matchesHistoryScope(item, record, scope))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const allBandCohort = recordsInWeightBand(exactAll, record.weight);
  let destinationRule = emptyWeightBandRule(record, scopeName);
  if (allBandCohort) {
    const recentBandRecords = recentRecords(allBandCohort.records, record.eventDate);
    const historicalBandRecords = allBandCohort.records.slice(-20);
    const valueCohort = recentBandRecords.length >= 3
      ? { records: recentBandRecords,
        name: `${scopeName}; faixa ${allBandCohort.band.label}; últimos 12 meses (máx. 20)`, limit: undefined }
      : { records: historicalBandRecords,
        name: `${scopeName}; faixa ${allBandCohort.band.label}; incluindo histórico anterior (máx. 20)`, limit: "Média" as const };
    destinationRule = evaluateRule(record.value, valueCohort.records, valueCohort.name, valueCohort.limit);
  }
  // Não há fallback para outras faixas: peso e valor formam uma única regra principal.
  const weightRule = destinationRule;
  const overallStatus = destinationRule.status;
  return { destinationName: record.destinationName, destinationRule, weightRule,
    confidenceScore: confidenceScoreFor(record.value, destinationRule), overallStatus };
}

const quantileOf = (source: number[], percentile: number) => {
  if (!source.length) return 0;
  const values = [...source].sort((a, b) => a - b);
  const position = (values.length - 1) * percentile;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
};

const ranks = (source: number[]) => source.map((value) => {
  const sorted = [...source].sort((a, b) => a - b);
  const first = sorted.indexOf(value), last = sorted.lastIndexOf(value);
  return (first + last) / 2 + 1;
});

const correlationOf = (left: number[], right: number[]) => {
  if (left.length < 2 || left.length !== right.length) return 0;
  const leftRanks = ranks(left), rightRanks = ranks(right);
  const leftMean = leftRanks.reduce((sum, value) => sum + value, 0) / leftRanks.length;
  const rightMean = rightRanks.reduce((sum, value) => sum + value, 0) / rightRanks.length;
  let numerator = 0, leftSquare = 0, rightSquare = 0;
  for (let index = 0; index < leftRanks.length; index += 1) {
    const leftDelta = leftRanks[index] - leftMean, rightDelta = rightRanks[index] - rightMean;
    numerator += leftDelta * rightDelta; leftSquare += leftDelta ** 2; rightSquare += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator ? numerator / denominator : 0;
};

function historicalInsights(records: StoredRecord[]): HistoricalInsights {
  const valid = records.filter((record) => record.weight > 0 && record.value > 0);
  const weights = valid.map((record) => record.weight);
  const values = valid.map((record) => record.value);
  const correlation = correlationOf(weights, values);
  const medianValue = medianOf(values);
  const medianPerTon = medianOf(valid.map((record) => record.value / (record.weight / 1000)));
  const logWeights = weights.map((weight) => Math.log10(weight));
  const q1 = quantileOf(logWeights, .25), q3 = quantileOf(logWeights, .75);
  const iqr = q3 - q1;
  const atypicalWeightCount = valid.length >= 5
    ? logWeights.filter((weight) => weight < q1 - iqr * 1.5 || weight > q3 + iqr * 1.5).length : 0;
  const uniqueValues = new Set(values.map((value) => value.toFixed(2))).size;
  const valueMadRatio = medianValue ? medianOf(values.map((value) => Math.abs(value - medianValue))) / medianValue : 0;
  let relationship: HistoricalInsights["relationship"] = "unclear";
  let relationshipLabel = "Relação pouco clara";
  let explanation = "O peso e o valor não apresentam um comportamento consistente.";
  if (valid.length < 5 || new Set(weights.map((weight) => weight.toFixed(3))).size < 3) {
    relationship = "insufficient"; relationshipLabel = "Amostra insuficiente";
    explanation = "São necessários ao menos 5 registros e 3 pesos diferentes.";
  } else if (valueMadRatio <= .15 && Math.max(...weights) / Math.max(Math.min(...weights), .001) >= 1.2) {
    relationship = "fixed"; relationshipLabel = "Preço aparentemente fixo";
    explanation = "O peso varia, mas a maior parte dos valores permanece próxima da mediana.";
  } else if (uniqueValues <= Math.max(3, Math.floor(valid.length / 3)) && Math.abs(correlation) >= .25) {
    relationship = "tiered"; relationshipLabel = "Indício de cobrança por faixas";
    explanation = "Os valores se repetem em poucos patamares enquanto o peso varia.";
  } else if (correlation >= .45) {
    relationship = "increasing"; relationshipLabel = "Preço crescente com o peso";
    explanation = "Cargas mais pesadas tendem a apresentar valores totais maiores.";
  } else if (correlation <= -.45) {
    relationship = "decreasing"; relationshipLabel = "Preço decrescente com o peso";
    explanation = "Cargas mais pesadas tendem a apresentar valores totais menores; revise unidade e negociação.";
  }
  const confidence: Confidence = valid.length >= 15 ? "Alta" : valid.length >= 8 ? "Média" : valid.length >= 5 ? "Baixa" : "Insuficiente";
  const bands = WEIGHT_BANDS.map((definition) => {
    const members = valid.filter((record) => isInWeightBand(record.weight, definition));
    const bandValues = members.map((record) => record.value);
    return { label: definition.label, count: members.length,
      medianWeight: medianOf(members.map((record) => record.weight)),
      averageValue: bandValues.length ? bandValues.reduce((sum, value) => sum + value, 0) / bandValues.length : 0,
      medianValue: medianOf(bandValues),
      minimumValue: bandValues.length ? Math.min(...bandValues) : 0,
      maximumValue: bandValues.length ? Math.max(...bandValues) : 0,
      medianPerTon: medianOf(members.map((record) => record.value / (record.weight / 1000))) };
  }).filter((band) => band.count > 0);
  return { relationship, relationshipLabel, explanation, confidence, correlation,
    validCount: valid.length, atypicalWeightCount, medianValue, medianPerTon, bands };
}

const financialOutcomeLabels: Record<FinancialOutcome, string> = {
  positive: "Saldo positivo",
  recovered: "Recuperação integral",
  "confirmed-loss": "Prejuízo confirmado",
  "at-risk": "Valor em risco",
  "absorbed-cost": "Custo absorvido",
  "included-in-freight": "Incluso no frete",
  inconsistent: "Inconsistência",
};

function classifyFinancialRecord(record: StoredRecord): FinancialOutcome {
  const received = record.receivedValue;
  const difference = (received ?? 0) - record.value;
  const tolerance = .01;
  if (record.financialStatus === "untreated" || record.financialStatus === "not-informed") return "at-risk";
  if (record.financialStatus === "other") return "inconsistent";
  if (record.financialStatus === "loss")
    return received !== null && received >= record.value - tolerance ? "inconsistent" : "confirmed-loss";
  if (record.reimbursement === "included-in-freight")
    return received !== null && received > tolerance ? "inconsistent" : "included-in-freight";
  if (record.reimbursement === "non-reimbursable")
    return received !== null && received >= record.value - tolerance ? "inconsistent" : "absorbed-cost";
  if (record.reimbursement !== "reimbursable" || received === null) return "inconsistent";
  if (difference > tolerance) return "positive";
  if (difference < -tolerance) return "confirmed-loss";
  return "recovered";
}

function financialSummary(records: StoredRecord[]): FinancialSummary {
  const outcomes = new Map<FinancialOutcome, FinancialSummary["outcomes"][number]>();
  const details = records.map((record) => {
    const received = record.receivedValue;
    const balance = (received ?? 0) - record.value;
    const outcome = classifyFinancialRecord(record);
    const unrecovered = Math.max(record.value - (received ?? 0), 0);
    const aggregate = outcomes.get(outcome) ?? { outcome, label: financialOutcomeLabels[outcome], count: 0,
      paid: 0, received: 0, balance: 0, unrecovered: 0 };
    aggregate.count += 1;
    aggregate.paid += record.value;
    aggregate.received += received ?? 0;
    aggregate.balance += balance;
    aggregate.unrecovered += unrecovered;
    outcomes.set(outcome, aggregate);
    return {
      id: record.id,
      eventDate: record.eventDate,
      process: record.process,
      paid: record.value,
      received,
      balance,
      recoveryRate: record.value > 0 ? ((received ?? 0) / record.value) * 100 : 0,
      financialStatus: record.financialStatus,
      reimbursement: record.reimbursement,
      outcome,
      outcomeLabel: financialOutcomeLabels[outcome],
    };
  });
  const totalPaid = records.reduce((sum, record) => sum + record.value, 0);
  const totalReceived = records.reduce((sum, record) => sum + (record.receivedValue ?? 0), 0);
  const ordered: FinancialOutcome[] = ["confirmed-loss", "at-risk", "absorbed-cost", "included-in-freight",
    "inconsistent", "recovered", "positive"];
  return {
    total: records.length,
    totalPaid,
    totalReceived,
    balance: totalReceived - totalPaid,
    unrecovered: outcomes.get("confirmed-loss")?.unrecovered ?? 0,
    recoveryRate: totalPaid > 0 ? (totalReceived / totalPaid) * 100 : 0,
    outcomes: ordered.map((outcome) => outcomes.get(outcome)).filter((item): item is NonNullable<typeof item> => Boolean(item)),
    records: details.sort((a, b) => b.eventDate.localeCompare(a.eventDate)).slice(0, 200),
  };
}

async function analyzeBatch(batchId: string, selectedGroup: string, selectedCostCenter: string,
  destinationCode: string): Promise<BatchAnalysisResult> {
  const batches = await getAll<BatchSummary>(BATCH_STORE);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) throw new Error("Lote não encontrado.");
  const records = await getAll<StoredRecord>(RECORD_STORE);
  const approved = new Set(batches.filter((item) => item.status === "approved" && item.id !== batchId).map((item) => item.id));
  const history = records.filter((record) => approved.has(record.batchId) && record.eventDate < batch.periodStart);
  const selected = records.filter((record) => record.batchId === batchId && clientGroup(record).code === selectedGroup
    && (record.costCenter || "__sem_cc__") === selectedCostCenter && record.destinationCode === destinationCode);
  if (!selected.length) throw new Error("Não há registros para o grupo de cliente, C.C e destinatário selecionados.");
  const counts: Record<Status, number> = { expected: 0, high: 0, low: 0, "very-high": 0, "very-low": 0, insufficient: 0 };
  const items = selected.sort((a, b) => a.eventDate.localeCompare(b.eventDate)).map((record) => {
    const result = analyzeRecord(record, history);
    counts[result.overallStatus] += 1;
    return { id: record.id, eventDate: record.eventDate, process: record.process, weight: record.weight,
      value: record.value, reimbursement: record.reimbursement, result };
  });
  const previous = new Date(`${batch.periodStart}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const historyPoints = history
    .filter((record) => clientGroup(record).code === selectedGroup
      && (record.costCenter || "__sem_cc__") === selectedCostCenter && record.destinationCode === destinationCode)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))
    .slice(-1000)
    .map((record) => ({ id: record.id, eventDate: record.eventDate, process: record.process,
      weight: record.weight, value: record.value }));
  return {
    sourceMode: "batch",
    batchId,
    clientName: clientGroup(selected[0]).name,
    costCenter: selected[0].costCenter,
    destinationName: selected[0].destinationName,
    baselineEnd: datePart(previous),
    baselineCount: history.length,
    total: items.length,
    counts,
    historyPoints,
    items,
    ruleVersion: "v8-weight-bands",
  };
}

function recorteSummaries(selected: StoredRecord[]) {
  const values = selected.map((record) => record.value).filter((value) => value > 0);
  const totalPaid = values.reduce((sum, value) => sum + value, 0);
  const reimbursementLabels: Record<StoredRecord["reimbursement"], string> = {
    reimbursable: "Reembolsável",
    "non-reimbursable": "Não reembolsável",
    "included-in-freight": "Incluso no frete",
    "not-informed": "Não informado",
  };
  const reimbursementOrder = Object.keys(reimbursementLabels) as StoredRecord["reimbursement"][];
  return {
    valueSummary: {
      totalPaid,
      average: values.length ? totalPaid / values.length : 0,
      median: medianOf(values),
      minimum: values.length ? Math.min(...values) : 0,
      maximum: values.length ? Math.max(...values) : 0,
    },
    reimbursementSummary: {
      total: selected.length,
      classified: selected.filter((record) => record.reimbursement !== "not-informed").length,
      items: reimbursementOrder.map((category) => {
        const count = selected.filter((record) => record.reimbursement === category).length;
        return { category, label: reimbursementLabels[category], count,
          percentage: selected.length ? (count / selected.length) * 100 : 0 };
      }),
    },
    financialSummary: financialSummary(selected),
    historicalInsights: historicalInsights(selected),
  };
}

function destinationClientSummaries(records: StoredRecord[]) {
  const groups = new Map<string, { name: string; records: StoredRecord[] }>();
  records.forEach((record) => {
    const group = clientGroup(record);
    const current = groups.get(group.code) ?? { name: group.name, records: [] };
    current.records.push(record);
    groups.set(group.code, current);
  });
  return [...groups].map(([clientCode, group]) => {
    const weighted = group.records.filter((record) => record.weight > 0 && record.value > 0);
    const totalPaid = group.records.reduce((sum, record) => sum + record.value, 0);
    const totalWeightTons = weighted.reduce((sum, record) => sum + record.weight / 1000, 0);
    return {
      clientCode,
      clientName: group.name,
      count: group.records.length,
      totalPaid,
      totalWeightTons,
      averageValue: group.records.length ? totalPaid / group.records.length : 0,
      averageWeightTons: weighted.length ? totalWeightTons / weighted.length : 0,
      medianValue: medianOf(group.records.map((record) => record.value).filter((value) => value > 0)),
      medianPerTon: medianOf(weighted.map((record) => record.value / (record.weight / 1000))),
    };
  }).sort((left, right) => right.count - left.count || left.clientName.localeCompare(right.clientName, "pt-BR"));
}

async function analyzeScenario(selectedGroup: string, selectedCostCenter: string, destinationCode: string,
  value: number, weight: number, eventDate = "", process = "",
  reimbursement: StoredRecord["reimbursement"] = "not-informed"): Promise<BatchAnalysisResult> {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Informe um valor de descarga maior que zero.");
  if (!Number.isFinite(weight) || weight <= 0) throw new Error("Informe um peso descarregado maior que zero.");
  const records = await approvedRecords();
  const references = records.filter((record) => clientGroup(record).code === selectedGroup
    && (record.costCenter || "__sem_cc__") === selectedCostCenter && record.destinationCode === destinationCode)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id.localeCompare(b.id));
  if (!references.length) throw new Error("Não há histórico aprovado para o grupo, C.C e destinatário selecionados.");
  const identity = references[references.length - 1];
  const today = datePart(new Date());
  const scenario: StoredRecord = {
    id: `scenario:${crypto.randomUUID()}`,
    batchId: "",
    fingerprint: "",
    eventDate: eventDate || today,
    branch: "",
    documentType: "",
    process: process || "Cenário informado",
    costCenter: identity.costCenter,
    clientCode: identity.clientCode,
    clientName: identity.clientName,
    destinationCode: identity.destinationCode,
    destinationName: identity.destinationName,
    weight,
    value,
    receivedValue: null,
    financialStatus: "not-informed",
    reimbursement,
  };
  const priorHistory = records.filter((candidate) => candidate.eventDate < scenario.eventDate);
  const result = analyzeHistoricalRecord(scenario, priorHistory.length ? priorHistory : records);
  const counts: Record<Status, number> = { expected: 0, high: 0, low: 0, "very-high": 0, "very-low": 0, insufficient: 0 };
  counts[result.overallStatus] = 1;
  return {
    sourceMode: "scenario",
    batchId: "",
    clientName: clientGroup(identity).name,
    costCenter: identity.costCenter,
    destinationName: identity.destinationName,
    baselineEnd: references[references.length - 1].eventDate,
    baselineCount: references.length,
    total: 1,
    counts,
    historyPoints: references.slice(-1000).map((record) => ({ id: record.id, eventDate: record.eventDate,
      process: record.process, weight: record.weight, value: record.value })),
    items: [{ id: scenario.id, eventDate: scenario.eventDate, process: scenario.process, weight, value,
      reimbursement: scenario.reimbursement, result }],
    ...recorteSummaries(references),
    ruleVersion: "v8-weight-bands",
  };
}

async function analyzeHistory(scope: HistoryScope, selectedGroup = "", selectedCostCenter = "",
  destinationCode = ""): Promise<BatchAnalysisResult> {
  const batches = await getAll<BatchSummary>(BATCH_STORE);
  const approved = new Set(batches.filter((batch) => batch.status === "approved").map((batch) => batch.id));
  const records = (await getAll<StoredRecord>(RECORD_STORE)).filter((record) => approved.has(record.batchId));
  if (scope === "client" && !selectedGroup) throw new Error("Selecione um grupo de cliente.");
  if (scope === "destination" && !destinationCode) throw new Error("Selecione um destinatário.");
  if (scope === "strict" && (!selectedGroup || !selectedCostCenter || !destinationCode))
    throw new Error("Selecione grupo de cliente, C.C e destinatário.");
  const selected = records.filter((record) => scope === "client"
    ? clientGroup(record).code === selectedGroup
    : scope === "destination" ? record.destinationCode === destinationCode
    : clientGroup(record).code === selectedGroup
      && (record.costCenter || "__sem_cc__") === selectedCostCenter && record.destinationCode === destinationCode)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id.localeCompare(b.id));
  if (!selected.length) throw new Error("Não há histórico aprovado para o recorte selecionado.");
  const counts: Record<Status, number> = { expected: 0, high: 0, low: 0, "very-high": 0, "very-low": 0, insufficient: 0 };
  const items: BatchAnalysisResult["items"] = [];
  const priorScopeRecords: StoredRecord[] = [];
  for (let index = 0; index < selected.length;) {
    const currentDate = selected[index].eventDate;
    const sameDate: StoredRecord[] = [];
    while (index < selected.length && selected[index].eventDate === currentDate) sameDate.push(selected[index++]);
    sameDate.forEach((record) => {
      const result = analyzeHistoricalRecord(record, priorScopeRecords, scope);
      // A classificação usa somente valores anteriores do mesmo recorte e da mesma faixa de peso.
      counts[result.destinationRule.status] += 1;
      items.push({ id: record.id, eventDate: record.eventDate, process: record.process,
        weight: record.weight, value: record.value, reimbursement: record.reimbursement, result });
    });
    priorScopeRecords.push(...sameDate);
  }
  const identity = selected[0];
  return {
    sourceMode: "history",
    historyScope: scope,
    batchId: "",
    clientName: scope === "destination" ? "Todos os clientes" : clientGroup(identity).name,
    costCenter: scope === "strict" ? identity.costCenter : "",
    destinationName: scope === "client" ? "Todos os destinatários" : identity.destinationName,
    baselineEnd: selected[selected.length - 1].eventDate,
    baselineCount: selected.length,
    total: items.length,
    counts,
    historyPoints: [],
    items,
    ...recorteSummaries(selected),
    destinationClients: scope === "destination" ? destinationClientSummaries(selected) : undefined,
    ruleVersion: "v8-weight-bands",
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest | StorageBridgeResponse>) => {
  const request = event.data;
  if ("bridge" in request) {
    const pending = bridgePending.get(request.bridgeId);
    if (!pending) return;
    bridgePending.delete(request.bridgeId);
    request.ok ? pending.resolve(request.result) : pending.reject(new Error(request.error || "Falha na persistência local."));
    return;
  }
  try {
    let response: WorkerResponse;
    if (request.type === "init") {
      response = { id: request.id, ok: true, type: "state", ...(await state()) };
    } else if (request.type === "import") {
      const batch = await importBatch(request);
      response = { id: request.id, ok: true, type: "imported", batch, ...(await state()) };
    } else if (request.type === "manualImport") {
      const batch = await importManualBatch(request);
      response = { id: request.id, ok: true, type: "imported", batch, ...(await state()) };
    } else if (request.type === "catalog") {
      response = { id: request.id, ok: true, type: "catalog",
        ...(await catalog(request.batchId, request.clientGroup, request.costCenter)) };
    } else if (request.type === "historyCatalog") {
      response = { id: request.id, ok: true, type: "catalog",
        ...(await historyCatalog(request.clientGroup, request.costCenter)) };
    } else if (request.type === "groupCatalog") {
      response = { id: request.id, ok: true, type: "groupCatalog", groups: await groupCatalog() };
    } else if (request.type === "setGroupOverrides") {
      clientGroupOverrides = request.overrides;
      response = { id: request.id, ok: true, type: "groupsUpdated",
        groups: await groupCatalog(), ...(await state()) };
    } else if (request.type === "approve") {
      await approve(request.batchId);
      response = { id: request.id, ok: true, type: "approved", ...(await state()) };
    } else if (request.type === "backfillReimbursement") {
      response = { id: request.id, ok: true, type: "backfilled",
        updated: await backfillReimbursement(request.buffer) };
    } else if (request.type === "backfillCostCenters") {
      response = { id: request.id, ok: true, type: "costCentersBackfilled",
        updated: await backfillCostCenters(request.buffer) };
    } else if (request.type === "backfillFinancials") {
      response = { id: request.id, ok: true, type: "financialsBackfilled",
        updated: await backfillFinancials(request.buffer) };
    } else if (request.type === "analyzeBatch") {
      response = { id: request.id, ok: true, type: "batchAnalysis",
        result: await analyzeBatch(request.batchId, request.clientGroup, request.costCenter, request.destinationCode) };
    } else if (request.type === "analyzeScenario") {
      response = { id: request.id, ok: true, type: "batchAnalysis",
        result: await analyzeScenario(request.clientGroup, request.costCenter, request.destinationCode,
          request.value, request.weight, request.eventDate, request.process, request.reimbursement) };
    } else {
      response = { id: request.id, ok: true, type: "batchAnalysis",
        result: await analyzeHistory(request.scope, request.clientGroup, request.costCenter, request.destinationCode) };
    }
    self.postMessage(response);
  } catch (error) {
    self.postMessage({ id: request.id, ok: false,
      error: error instanceof Error ? error.message : "Falha ao processar a base." } satisfies WorkerResponse);
  }
};

export {};
