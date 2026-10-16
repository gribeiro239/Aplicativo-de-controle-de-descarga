export type Status =
  | "expected"
  | "high"
  | "low"
  | "very-high"
  | "very-low"
  | "insufficient";

export type Confidence = "Alta" | "Média" | "Baixa" | "Insuficiente";
export type Periodicity = "historical" | "daily" | "weekly" | "monthly";
export type HistoryScope = "strict" | "client" | "destination";
export type BatchStatus = "pending" | "approved";
export type ReimbursementCategory = "reimbursable" | "non-reimbursable" | "included-in-freight" | "not-informed";
export type FinancialStatus = "charged" | "loss" | "untreated" | "not-informed" | "other";
export type FinancialOutcome = "positive" | "recovered" | "confirmed-loss" | "at-risk"
  | "absorbed-cost" | "included-in-freight" | "inconsistent";

export type CatalogItem = { code: string; name: string };

export type ClientAlias = {
  key: string;
  code: string;
  name: string;
  recordCount: number;
};

export type ClientGroupSummary = {
  code: string;
  name: string;
  recordCount: number;
  costCenterCount: number;
  aliases: ClientAlias[];
};

export type ClientGroupOverride = Record<string, { code: string; name: string }>;

export type StoredRecord = {
  id: string;
  batchId: string;
  fingerprint: string;
  eventDate: string;
  branch: string;
  documentType: string;
  process: string;
  costCenter: string;
  clientCode: string;
  clientName: string;
  destinationCode: string;
  destinationName: string;
  weight: number;
  value: number;
  receivedValue: number | null;
  financialStatus: FinancialStatus;
  reimbursement: ReimbursementCategory;
};

export type ManualRecordInput = {
  eventDate: string;
  branch: string;
  documentType: string;
  process: string;
  costCenter: string;
  clientCode: string;
  clientName: string;
  destinationCode: string;
  destinationName: string;
  weight: number;
  value: number;
  reimbursement: ReimbursementCategory;
};

export type BatchSummary = {
  id: string;
  name: string;
  fileName: string;
  periodicity: Periodicity;
  periodStart: string;
  periodEnd: string;
  status: BatchStatus;
  rowCount: number;
  duplicateCount: number;
  outOfPeriodCount: number;
  importedAt: string;
  approvedAt?: string;
  ruleVersion: "v1";
};

export type DashboardSummary = {
  historicalRowCount: number;
  clientCount: number;
  destinationCount: number;
  pendingBatchCount: number;
};

export type RuleResult = {
  status: Status;
  median: number;
  average: number;
  minimum: number;
  maximum: number;
  mad: number;
  lower: number;
  upper: number;
  difference: number;
  count: number;
  confidence: Confidence;
  explanation: string;
};

export type HistoricalConfidenceScore = {
  score: number | null;
  valueScore: number | null;
  weightValueScore: number | null;
  label: "Alta" | "Moderada" | "Baixa" | "Muito baixa" | "Histórico insuficiente";
};

export type AnalysisResult = {
  destinationName: string;
  destinationRule: RuleResult;
  weightRule: RuleResult;
  confidenceScore: HistoricalConfidenceScore;
  overallStatus: Status;
};

export type AnalyzedRecord = {
  id: string;
  eventDate: string;
  process: string;
  weight: number;
  value: number;
  reimbursement: ReimbursementCategory;
  result: AnalysisResult;
};

export type HistoricalValueSummary = {
  totalPaid: number;
  average: number;
  median: number;
  minimum: number;
  maximum: number;
};

export type ReimbursementItem = {
  category: ReimbursementCategory;
  label: string;
  count: number;
  percentage: number;
};

export type ReimbursementSummary = {
  total: number;
  classified: number;
  items: ReimbursementItem[];
};

export type FinancialOutcomeSummary = {
  outcome: FinancialOutcome;
  label: string;
  count: number;
  paid: number;
  received: number;
  balance: number;
  unrecovered: number;
};

export type FinancialRecordResult = {
  id: string;
  eventDate: string;
  process: string;
  paid: number;
  received: number | null;
  balance: number;
  recoveryRate: number;
  financialStatus: FinancialStatus;
  reimbursement: ReimbursementCategory;
  outcome: FinancialOutcome;
  outcomeLabel: string;
};

export type FinancialSummary = {
  total: number;
  totalPaid: number;
  totalReceived: number;
  balance: number;
  unrecovered: number;
  recoveryRate: number;
  outcomes: FinancialOutcomeSummary[];
  records: FinancialRecordResult[];
};

export type ChartPoint = {
  id: string;
  eventDate: string;
  process: string;
  weight: number;
  value: number;
};

export type WeightBandSummary = {
  label: string;
  count: number;
  medianWeight: number;
  averageValue: number;
  medianValue: number;
  minimumValue: number;
  maximumValue: number;
  medianPerTon: number;
};

export type HistoricalInsights = {
  relationship: "insufficient" | "fixed" | "increasing" | "decreasing" | "tiered" | "unclear";
  relationshipLabel: string;
  explanation: string;
  confidence: Confidence;
  correlation: number;
  validCount: number;
  atypicalWeightCount: number;
  medianValue: number;
  medianPerTon: number;
  bands: WeightBandSummary[];
};

export type DestinationClientSummary = {
  clientCode: string;
  clientName: string;
  count: number;
  totalPaid: number;
  totalWeightTons: number;
  averageValue: number;
  averageWeightTons: number;
  medianValue: number;
  medianPerTon: number;
};

export type BatchAnalysisResult = {
  sourceMode: "batch" | "history" | "scenario";
  historyScope?: HistoryScope;
  batchId: string;
  clientName: string;
  costCenter: string;
  destinationName: string;
  baselineEnd: string;
  baselineCount: number;
  total: number;
  counts: Record<Status, number>;
  historyPoints: ChartPoint[];
  items: AnalyzedRecord[];
  valueSummary?: HistoricalValueSummary;
  reimbursementSummary?: ReimbursementSummary;
  financialSummary?: FinancialSummary;
  historicalInsights?: HistoricalInsights;
  destinationClients?: DestinationClientSummary[];
  ruleVersion: "v1" | "v1-strict" | "v2-history" | "v3-history" | "v3-history-strict" | "v4-macro" | "v5-financial" | "v6-scopes" | "v7-one-sided-value" | "v8-weight-bands";
};

export type WorkerRequest =
  | { id: number; type: "init" }
  | {
      id: number;
      type: "import";
      fileName: string;
      name: string;
      periodicity: Periodicity;
      periodStart?: string;
      periodEnd?: string;
      status?: BatchStatus;
      buffer: ArrayBuffer;
    }
  | { id: number; type: "catalog"; batchId: string; clientGroup?: string; costCenter?: string }
  | {
      id: number;
      type: "manualImport";
      name: string;
      periodicity: Periodicity;
      periodStart: string;
      periodEnd: string;
      status?: BatchStatus;
      fileName?: string;
      records: ManualRecordInput[];
    }
  | { id: number; type: "historyCatalog"; clientGroup?: string; costCenter?: string }
  | { id: number; type: "groupCatalog" }
  | { id: number; type: "setGroupOverrides"; overrides: ClientGroupOverride }
  | { id: number; type: "approve"; batchId: string }
  | { id: number; type: "backfillReimbursement"; buffer: ArrayBuffer }
  | { id: number; type: "backfillCostCenters"; buffer: ArrayBuffer }
  | { id: number; type: "backfillFinancials"; buffer: ArrayBuffer }
  | { id: number; type: "analyzeBatch"; batchId: string; clientGroup: string; costCenter: string; destinationCode: string }
  | { id: number; type: "analyzeScenario"; clientGroup: string; costCenter: string;
      destinationCode: string; value: number; weight: number; eventDate?: string;
      process?: string; reimbursement?: ReimbursementCategory }
  | { id: number; type: "analyzeHistory"; scope: HistoryScope;
      clientGroup?: string; costCenter?: string; destinationCode?: string };

export type WorkerResponse =
  | { id: number; ok: true; type: "state"; summary: DashboardSummary; batches: BatchSummary[] }
  | { id: number; ok: true; type: "imported"; batch: BatchSummary; summary: DashboardSummary; batches: BatchSummary[] }
  | { id: number; ok: true; type: "catalog"; clients: CatalogItem[]; costCenters: CatalogItem[]; destinations: CatalogItem[] }
  | { id: number; ok: true; type: "groupCatalog"; groups: ClientGroupSummary[] }
  | { id: number; ok: true; type: "groupsUpdated"; groups: ClientGroupSummary[];
      summary: DashboardSummary; batches: BatchSummary[] }
  | { id: number; ok: true; type: "approved"; summary: DashboardSummary; batches: BatchSummary[] }
  | { id: number; ok: true; type: "backfilled"; updated: number }
  | { id: number; ok: true; type: "costCentersBackfilled"; updated: number }
  | { id: number; ok: true; type: "financialsBackfilled"; updated: number }
  | { id: number; ok: true; type: "batchAnalysis"; result: BatchAnalysisResult }
  | { id: number; ok: false; error: string };

export type StorageBridgeRequest =
  | { bridge: "storage-request"; bridgeId: number; operation: "getAll"; storeName: "batches" | "records" }
  | { bridge: "storage-request"; bridgeId: number; operation: "import"; batch: BatchSummary; records: StoredRecord[] }
  | { bridge: "storage-request"; bridgeId: number; operation: "approve"; batchId: string; approvedAt: string }
  | { bridge: "storage-request"; bridgeId: number; operation: "updateReimbursements";
      records: Array<Pick<StoredRecord, "fingerprint" | "reimbursement">> }
  | { bridge: "storage-request"; bridgeId: number; operation: "updateCostCenters";
      records: Array<Pick<StoredRecord, "fingerprint" | "costCenter">> }
  | { bridge: "storage-request"; bridgeId: number; operation: "updateFinancials";
      records: Array<Pick<StoredRecord, "fingerprint" | "receivedValue" | "financialStatus">> };

export type StorageBridgeResponse = {
  bridge: "storage-response";
  bridgeId: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};
