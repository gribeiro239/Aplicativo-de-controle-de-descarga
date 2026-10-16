import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ClipboardList, Database, Download, FileSpreadsheet,
  FileText, History, LayoutDashboard, LoaderCircle, RotateCcw, Search, Upload, X,
} from "lucide-react";
import type {
  AnalyzedRecord, BatchAnalysisResult, BatchSummary, CatalogItem, ClientGroupOverride, DashboardSummary,
  HistoryScope, Periodicity, RuleResult, Status,
  StorageBridgeRequest, WorkerRequest, WorkerResponse,
} from "./analytics.types";
import { createBackup, handleStorageRequest, restoreBackup, storageMode } from "./storage";
import {
  extractPdfData, normalizePdfLookup, pdfFieldStatus, pdfFieldStatusLabel, type ExtractedPdfData,
} from "./pdf-extraction";
import { isInWeightBand, weightBandFor } from "./weight-bands";
import {
  botIntegrationAvailable, claimBotRequest, completeBotRequest,
} from "./bot-integration";

type Pending = { resolve: (response: WorkerResponse) => void; reject: (error: Error) => void };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type WorkerRequestMessage = WithoutId<WorkerRequest>;
const inputNumber = (value: string) => {
  const raw = value.trim();
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(/,(?=[^,]*$)/, ".").replace(/,/g, "") : raw;
  const parsed = Number(normalized.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const GROUP_OVERRIDES_KEY = "app-descarga-client-group-overrides-v1";
const loadGroupOverrides = (): ClientGroupOverride => {
  try { return JSON.parse(localStorage.getItem(GROUP_OVERRIDES_KEY) || "{}"); }
  catch { return {}; }
};

type PdfDraft = ExtractedPdfData & { matchedClientCode: string };
const catalogMatch = (value: string, items: CatalogItem[]) => {
  const target = normalizePdfLookup(value);
  if (!target) return null;
  const targetTokens = new Set(target.split(" ").filter((token) => token.length > 2));
  const ranked = items.map((item) => {
    const candidate = normalizePdfLookup(item.name);
    if (candidate === target) return { item, score: 1 };
    if (candidate && (target.includes(candidate) || candidate.includes(target))) return { item, score: .92 };
    const tokens = new Set(candidate.split(" ").filter((token) => token.length > 2));
    const common = [...targetTokens].filter((token) => tokens.has(token)).length;
    const total = new Set([...targetTokens, ...tokens]).size || 1;
    return { item, score: common / total };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.score >= .45 ? ranked[0].item : null;
};
const exactCatalogMatch = (value: string, items: CatalogItem[]) => {
  const target = normalizePdfLookup(value).replace(/\s+/g, "").replace(/^0+/, "");
  return items.find((item) => [item.code, item.name]
    .some((candidate) => normalizePdfLookup(candidate).replace(/\s+/g, "").replace(/^0+/, "") === target)) ?? null;
};
const decimalInput = (value: number, decimals = 2) => value > 0
  ? value.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "";

const currency = (amount: number) => amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const number = (value: number) => value.toLocaleString("pt-BR");
const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR") : "—";

const PdfExtractedFields = ({ draft }: { draft: PdfDraft }) => {
  const fields = [
    { status: pdfFieldStatus(!!draft.clientName, !!draft.matchedClientCode), label: "Cliente", value: draft.clientName || "Não encontrado" },
    { status: pdfFieldStatus(!!draft.documentType), label: "Tipo", value: draft.documentType || "Não encontrado" },
    { status: pdfFieldStatus(!!draft.branch), label: "Filial", value: draft.branch || "Não encontrada" },
    { status: pdfFieldStatus(!!draft.costCenter), label: "Centro de custo", value: draft.costCenter || "Não encontrado" },
    { status: pdfFieldStatus(draft.value > 0), label: "Valor pago", value: draft.value > 0 ? currency(draft.value) : "Não encontrado" },
    { status: pdfFieldStatus(draft.weight > 0), label: "Peso", value: draft.weight > 0 ? `${number(draft.weight)} kg` : "Não encontrado" },
    { status: pdfFieldStatus(!!draft.destinationCode), label: "Código destinatário (COD_DES)", value: draft.destinationCode || "Não encontrado" },
    { status: pdfFieldStatus(!!draft.destinationName), label: "Destinatário", value: draft.destinationName || "Não encontrado" },
  ];
  return <dl className="pdf-extracted-grid">{fields.map((field) => (
    <div key={field.label} className={field.status}>
      <dt>{field.label}<span>{pdfFieldStatusLabel[field.status]}</span></dt>
      <dd>{field.value}</dd>
    </div>
  ))}</dl>;
};

const statusLabel = (status: Status) => ({
  expected: "Dentro do esperado", high: "Acima do esperado", low: "Abaixo do esperado",
  "very-high": "Muito acima do esperado", "very-low": "Muito abaixo do esperado",
  insufficient: "Histórico insuficiente",
})[status];
const botResult = (status: Status) => ({
  expected: "DENTRO_DO_ESPERADO",
  high: "ACIMA_DO_ESPERADO",
  low: "ABAIXO_DO_ESPERADO",
  "very-high": "MUITO_ACIMA_DO_ESPERADO",
  "very-low": "MUITO_ABAIXO_DO_ESPERADO",
  insufficient: "HISTORICO_INSUFICIENTE",
})[status];
const statusTone = (status: Status) => status === "expected" ? "expected" : status === "insufficient"
  ? "neutral" : status === "very-high" || status === "very-low" ? "danger" : "warning";
const periodicityLabel: Record<Periodicity, string> = {
  historical: "Base histórica", daily: "Diário", weekly: "Semanal", monthly: "Mensal",
};
const suggestedPeriodEnd = (start: string, frequency: Periodicity) => {
  if (!start || frequency === "historical") return start;
  const value = new Date(`${start}T00:00:00Z`);
  if (frequency === "weekly") value.setUTCDate(value.getUTCDate() + 6);
  if (frequency === "monthly") value.setUTCMonth(value.getUTCMonth() + 1, 0);
  return value.toISOString().slice(0, 10);
};

function RuleCard({ title, rule }: { title: string; rule: RuleResult }) {
  const tone = statusTone(rule.status);
  return <article className={`rule-card ${tone}`}>
    <div className="rule-card-head">
      <div className="rule-icon">{tone === "expected" ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>}</div>
      <div><span>{title}</span><h4>{statusLabel(rule.status)}</h4></div>
      <span className={`confidence ${tone}`}>Confiança {rule.confidence.toLowerCase()}</span>
    </div>
    <p className="rule-source">Base: {rule.explanation}</p>
    {rule.median > 0 ? <div className="rule-stats">
      <div><span>Média</span><strong>{currency(rule.average)}</strong></div>
      <div><span>Mediana</span><strong>{currency(rule.median)}</strong></div>
      <div><span>Menor valor</span><strong>{currency(rule.minimum)}</strong></div>
      <div><span>Maior valor</span><strong>{currency(rule.maximum)}</strong></div>
      <div><span>MAD</span><strong>{currency(rule.mad)}</strong></div>
      <div><span>Limite esperado</span><strong>{rule.count >= 3 ? `Até ${currency(rule.upper)}` : "Amostra insuficiente"}</strong></div>
      <div><span>Diferença</span><strong>{rule.difference > 0 ? "+" : ""}{rule.difference}%</strong></div>
      <div><span>Comparáveis</span><strong>{number(rule.count)}</strong></div>
    </div> : <p className="rule-empty">Não há registros válidos nesta faixa de peso.</p>}
  </article>;
}

function ConfidenceScoreCard({ record }: { record: AnalyzedRecord }) {
  const confidence = record.result.confidenceScore;
  const tone = confidence.score === null ? "neutral" : confidence.score >= 85 ? "expected"
    : confidence.score >= 50 ? "warning" : "danger";
  return <section className={`confidence-score-card ${tone}`}>
    <div className="confidence-score-main">
      <div><span className="eyebrow">SCORE DE CONFIANÇA</span>
        <h2>{confidence.score === null ? "—" : `${confidence.score}%`}</h2></div>
      <div className="confidence-score-copy"><strong>{confidence.label}</strong>
        <p>{confidence.score === null
          ? "São necessários ao menos 3 valores históricos na mesma faixa de peso."
          : "Aderência à mediana histórica da faixa; valores menores não reduzem o score."}</p></div>
    </div>
    {confidence.score !== null && <div className="confidence-score-track" aria-label={`Score de confiança ${confidence.score}%`}>
      <i style={{ width: `${confidence.score}%` }}/>
    </div>}
    <div className="confidence-score-details">
      <div><span>Valor na faixa de peso</span><strong>{confidence.valueScore === null ? "Sem base" : `${confidence.valueScore}%`}</strong>
        <small>{confidence.valueScore === null ? "Menos de 3 comparáveis na faixa" : `Mediana ${currency(record.result.destinationRule.median)}`}</small></div>
    </div>
  </section>;
}

function PriceHistoryChart({ analysis, selectedId, onSelect }: {
  analysis: BatchAnalysisResult; selectedId: string; onSelect: (record: AnalyzedRecord) => void;
}) {
  const width = 1000, height = 330;
  const margin = { top: 28, right: 28, bottom: 52, left: 82 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const selectedRecord = analysis.items.find((item) => item.id === selectedId);
  const currentRule = selectedRecord?.result.destinationRule;
  const selectedBand = selectedRecord ? weightBandFor(selectedRecord.weight) : undefined;
  const allPoints = [...analysis.historyPoints, ...analysis.items]
    .filter((point) => !selectedBand || isInWeightBand(point.weight, selectedBand));
  const times = allPoints.map((point) => new Date(`${point.eventDate}T00:00:00Z`).valueOf());
  const day = 86400000;
  const rawMinTime = times.length ? Math.min(...times) : Date.now() - day;
  const rawMaxTime = times.length ? Math.max(...times) : Date.now();
  const minTime = rawMinTime === rawMaxTime ? rawMinTime - day : rawMinTime;
  const maxTime = rawMinTime === rawMaxTime ? rawMaxTime + day : rawMaxTime;
  const values = allPoints.map((point) => point.value);
  if (currentRule?.median) values.push(currentRule.median, currentRule.upper);
  const rawMinValue = values.length ? Math.min(...values) : 0;
  const rawMaxValue = values.length ? Math.max(...values) : 1;
  const spread = Math.max(rawMaxValue - rawMinValue, rawMaxValue * .2, 1);
  const minValue = Math.max(0, rawMinValue - spread * .12);
  const maxValue = rawMaxValue + spread * .15;
  const x = (eventDate: string) => margin.left + ((new Date(`${eventDate}T00:00:00Z`).valueOf() - minTime) / (maxTime - minTime)) * plotWidth;
  const y = (value: number) => margin.top + (1 - (value - minValue) / (maxValue - minValue)) * plotHeight;
  const yTicks = Array.from({ length: 5 }, (_, index) => minValue + ((maxValue - minValue) * index) / 4);
  const xTicks = Array.from({ length: 4 }, (_, index) => minTime + ((maxTime - minTime) * index) / 3);
  const compactCurrency = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const pointStatus = (point: AnalyzedRecord) => analysis.sourceMode === "history"
    ? point.result.destinationRule.status : point.result.overallStatus;

  return <section className="price-chart-panel">
    <div className="price-chart-head"><div><span className="eyebrow">HISTÓRICO DE PREÇOS</span><h2>{analysis.clientName} × {analysis.destinationName}</h2></div>
      <div className="chart-legend">{analysis.sourceMode === "batch" && <span><i className="history-dot"/>Histórico anterior</span>}<span><i className="current-dot"/>{analysis.sourceMode === "history" ? "Registros avaliados" : "Lote atual"}</span><span><i className="range-dot"/>Até o limite esperado</span></div></div>
    <div className="price-chart-scroll">
      <svg className="price-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Histórico de preços de ${analysis.clientName} para ${analysis.destinationName}`}>
        <title>Histórico de preços por data</title>
        {currentRule && currentRule.count >= 3 && <>
          <rect className="expected-range" x={margin.left} y={y(currentRule.upper)} width={plotWidth} height={Math.max(0, height - margin.bottom - y(currentRule.upper))}/>
          <line className="median-chart-line" x1={margin.left} x2={width - margin.right} y1={y(currentRule.median)} y2={y(currentRule.median)}/>
          <text className="median-chart-label" x={width - margin.right - 5} y={y(currentRule.median) - 7} textAnchor="end">Mediana {compactCurrency(currentRule.median)}</text>
        </>}
        {yTicks.map((tick) => <g key={tick}>
          <line className="chart-grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)}/>
          <text className="chart-axis-label" x={margin.left - 12} y={y(tick) + 4} textAnchor="end">{compactCurrency(tick)}</text>
        </g>)}
        {xTicks.map((tick) => <text key={tick} className="chart-axis-label" x={margin.left + ((tick - minTime) / (maxTime - minTime)) * plotWidth} y={height - 19} textAnchor="middle">
          {new Date(tick).toLocaleDateString("pt-BR", { timeZone: "UTC", month: "short", year: "2-digit" })}
        </text>)}
        <line className="chart-axis" x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom}/>
        <line className="chart-axis" x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom}/>
        {analysis.historyPoints.filter((point) => !selectedBand || isInWeightBand(point.weight, selectedBand)).map((point) => <circle key={point.id} className="history-point" cx={x(point.eventDate)} cy={y(point.value)} r="4">
          <title>{`${date(point.eventDate)} · Processo ${point.process || "—"} · ${currency(point.value)} · Peso ${number(point.weight)}`}</title>
        </circle>)}
        {analysis.items.filter((point) => !selectedBand || isInWeightBand(point.weight, selectedBand)).map((point, index) => <g key={point.id} className="current-point-group" role="button" tabIndex={0}
          aria-label={`${date(point.eventDate)}, ${currency(point.value)}, ${statusLabel(pointStatus(point))}`}
          onClick={() => onSelect(point)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(point); }}>
          {selectedId === point.id && <circle className="selected-point-ring" cx={x(point.eventDate) + ((index % 5) - 2) * 3} cy={y(point.value)} r="10"/>}
          <circle className={`current-point ${statusTone(pointStatus(point))}`} cx={x(point.eventDate) + ((index % 5) - 2) * 3} cy={y(point.value)} r="6">
            <title>{`${date(point.eventDate)} · Processo ${point.process || "—"} · ${currency(point.value)} · Peso ${number(point.weight)} · ${statusLabel(pointStatus(point))}`}</title>
          </circle>
        </g>)}
        <text className="chart-axis-title" transform={`translate(20 ${margin.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">Valor da descarga</text>
        <text className="chart-axis-title" x={margin.left + plotWidth / 2} y={height - 2} textAnchor="middle">Data da descarga</text>
      </svg>
    </div>
    <p className="chart-caption">Exibindo somente registros da faixa {selectedBand?.label ?? "de peso selecionada"}. A referência segue a regra principal: {currentRule?.explanation.toLowerCase()}.</p>
  </section>;
}

function HistoricalInsightsPanel({ analysis }: { analysis: BatchAnalysisResult }) {
  const insights = analysis.historicalInsights;
  if (!insights) return null;
  const correlationText = Math.abs(insights.correlation) < .25 ? "Fraca" : Math.abs(insights.correlation) < .45 ? "Moderada" : "Forte";
  return <section className="history-insights-panel">
    <div className="insights-heading"><div><span className="eyebrow">ANÁLISE 4 · PESO × VALOR</span><h2>{insights.relationshipLabel}</h2><p>{insights.explanation}</p></div>
      <span className={`confidence ${insights.confidence === "Insuficiente" ? "neutral" : insights.confidence === "Baixa" ? "warning" : "expected"}`}>Confiança {insights.confidence.toLowerCase()}</span></div>
    <div className="insight-stats">
      <div><span>Amostra válida</span><strong>{number(insights.validCount)}</strong></div>
      <div><span>Valor mediano</span><strong>{currency(insights.medianValue)}</strong></div>
      <div><span>Mediana por tonelada</span><strong>{currency(insights.medianPerTon)}/t</strong></div>
      <div><span>Relação estatística</span><strong>{correlationText} ({insights.correlation.toLocaleString("pt-BR", { maximumFractionDigits: 2 })})</strong></div>
    </div>
    {insights.atypicalWeightCount > 0 && <div className="data-quality-warning"><AlertTriangle size={16}/><span>{insights.atypicalWeightCount} peso(s) estatisticamente atípico(s). Confirme a unidade antes de tomar decisões por tonelada.</span></div>}
    <div className="weight-band-table-wrap"><table className="weight-band-table"><thead><tr><th>Faixa de peso</th><th>Registros</th><th>Peso mediano</th><th>Valor médio</th><th>Valor mediano</th><th>Menor valor</th><th>Maior valor</th><th>Mediana por tonelada</th></tr></thead>
      <tbody>{insights.bands.map((band) => <tr key={band.label}><td>{band.label}</td><td>{number(band.count)}</td><td>{number(band.medianWeight)} kg</td><td>{currency(band.averageValue)}</td><td>{currency(band.medianValue)}</td><td>{currency(band.minimumValue)}</td><td>{currency(band.maximumValue)}</td><td>{currency(band.medianPerTon)}/t</td></tr>)}</tbody></table></div>
    <p className="chart-caption">A classificação compara o valor total somente com registros do mesmo recorte e da mesma faixa de peso. São necessários ao menos 3 comparáveis; o valor por tonelada é informativo.</p>
  </section>;
}

function DestinationClientsPanel({ analysis }: { analysis: BatchAnalysisResult }) {
  const clients = analysis.destinationClients;
  if (!clients?.length) return null;
  return <section className="destination-clients-panel">
    <div className="destination-clients-heading"><div><span className="eyebrow">ANÁLISE 5 · CLIENTES DO DESTINATÁRIO</span>
      <h2>Valor e tonelagem por cliente</h2><p>Comparação dos clientes atendidos pelo destinatário selecionado.</p></div>
      <span>{number(clients.length)} cliente(s)</span></div>
    <div className="destination-clients-table-wrap"><table className="destination-clients-table"><thead><tr>
      <th>Cliente</th><th>Registros</th><th>Total pago</th><th>Peso total</th><th>Valor por registro</th><th>Peso por registro</th><th>Valor mediano</th><th>Mediana por tonelada</th>
    </tr></thead><tbody>{clients.map((client) => <tr key={client.clientCode}>
      <td><strong>{client.clientName}</strong></td><td>{number(client.count)}</td><td>{currency(client.totalPaid)}</td>
      <td>{number(client.totalWeightTons)} t</td><td>{currency(client.averageValue)}</td><td>{number(client.averageWeightTons)} t</td>
      <td>{currency(client.medianValue)}</td><td>{currency(client.medianPerTon)}/t</td>
    </tr>)}</tbody></table></div>
    <p className="chart-caption">Peso total e valor por tonelada dependem da unidade informada no campo PESO; confirme valores atípicos antes da comparação.</p>
  </section>;
}

function FinancialResultPanel({ analysis }: { analysis: BatchAnalysisResult }) {
  const summary = analysis.financialSummary;
  if (!summary) return null;
  const statusLabels = { charged: "Cobrado", loss: "Prejuízo", untreated: "Não tratado",
    "not-informed": "Não informado", other: "Outro" } as const;
  const reimbursementLabels = { reimbursable: "Reembolsável", "non-reimbursable": "Não reembolsável",
    "included-in-freight": "Incluso no frete", "not-informed": "Não informado" } as const;
  const tone = (outcome: string) => outcome === "confirmed-loss" ? "danger" : outcome === "at-risk"
    || outcome === "inconsistent" ? "warning" : outcome === "positive" || outcome === "recovered" ? "expected" : "neutral";
  return <section className="financial-result-panel">
    <div className="financial-heading"><div><span className="eyebrow">ANÁLISE 3 · RESULTADO FINANCEIRO</span><h2>Pago × recebido</h2>
      <p>A regra interpreta o saldo junto com STATUS e REEMB?, evitando tratar custos absorvidos ou incluídos no frete como cobrança comum.</p></div>
      <span className={`financial-balance ${summary.balance < 0 ? "negative" : "positive"}`}>Saldo direto {currency(summary.balance)}</span></div>
    <div className="financial-summary-row">
      <div className="financial-kpis">
        <div><span>Total pago</span><strong>{currency(summary.totalPaid)}</strong></div>
        <div><span>Total recebido</span><strong>{currency(summary.totalReceived)}</strong></div>
        <div><span>Taxa de recuperação</span><strong>{summary.recoveryRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</strong></div>
        <div className="loss"><span>Prejuízo confirmado</span><strong>{currency(summary.unrecovered)}</strong></div>
      </div>
      <div className="financial-outcomes">{summary.outcomes.map((item) => <article key={item.outcome} className={tone(item.outcome)}>
        <div><span>{item.label}</span><strong>{number(item.count)}</strong></div>
        <small>{currency(item.unrecovered)} de diferença não recuperada</small>
      </article>)}</div>
    </div>
    <div className="financial-table-wrap"><table className="financial-table"><thead><tr><th>Data</th><th>Processo</th><th>Pago</th><th>Recebido</th>
      <th>Diferença</th><th>STATUS</th><th>REEMB?</th><th>Resultado</th></tr></thead><tbody>
      {summary.records.map((record) => <tr key={record.id}><td>{date(record.eventDate)}</td><td>{record.process || "—"}</td>
        <td>{currency(record.paid)}</td><td>{record.received === null ? "—" : currency(record.received)}</td>
        <td className={record.balance < 0 ? "negative" : "positive"}>{currency(record.balance)}</td>
        <td>{statusLabels[record.financialStatus]}</td><td>{reimbursementLabels[record.reimbursement]}</td>
        <td><span className={`financial-status ${tone(record.outcome)}`}>{record.outcomeLabel}</span></td></tr>)}
    </tbody></table></div>
    <p className="chart-caption">A tabela mostra os 200 registros mais recentes. “Saldo direto” não representa lucro final quando o custo é não reembolsável ou está incluso no frete.</p>
  </section>;
}

function ReimbursementPanel({ analysis }: { analysis: BatchAnalysisResult }) {
  const summary = analysis.reimbursementSummary;
  if (!summary) return null;
  const visible = summary.items.filter((item) => item.category !== "not-informed" || item.count > 0);
  return <section className="reimbursement-panel">
    <div className="reimbursement-heading">
      <div><span className="eyebrow">ANÁLISE 2 · REEMB?</span><h2>Distribuição do reembolso</h2>
        <p>Percentuais calculados somente sobre {number(summary.total)} registros do cliente e destinatário selecionados.</p></div>
      <span className="reimbursement-coverage">{number(summary.classified)} classificados</span>
    </div>
    <div className="reimbursement-grid">
      {visible.map((item) => <article key={item.category} className={`reimbursement-card ${item.category}`}>
        <div><span>{item.label}</span><strong>{item.percentage.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</strong></div>
        <div className="reimbursement-bar"><i style={{ width: `${item.percentage}%` }}/></div>
        <small>{number(item.count)} ocorrência(s) de {number(summary.total)}</small>
      </article>)}
    </div>
  </section>;
}

function BatchCard({ batch, selected, onSelect, onApprove, busy }: {
  batch: BatchSummary; selected: boolean; onSelect: () => void; onApprove: () => void; busy: boolean;
}) {
  const isManual = batch.fileName === "Entrada manual";
  return <article className={`batch-card ${selected ? "selected" : ""}`} onClick={onSelect}>
    <div className="batch-card-icon">{isManual ? <ClipboardList size={19}/> : <FileSpreadsheet size={19}/>}</div>
    <div className="batch-card-main">
      <div className="batch-card-title"><strong>{batch.name}</strong>
        <span className={`batch-status ${batch.status}`}>{batch.status === "approved" ? "Histórico" : "Aguardando aprovação"}</span>
      </div>
      <span>{periodicityLabel[batch.periodicity]} · {date(batch.periodStart)} a {date(batch.periodEnd)}</span>
      <small>{number(batch.rowCount)} registros · {batch.fileName}</small>
      {(batch.duplicateCount > 0 || batch.outOfPeriodCount > 0) && <small className="batch-warning">
        {batch.duplicateCount > 0 ? `${batch.duplicateCount} duplicado(s) ignorado(s)` : ""}
        {batch.duplicateCount > 0 && batch.outOfPeriodCount > 0 ? " · " : ""}
        {batch.outOfPeriodCount > 0 ? `${batch.outOfPeriodCount} fora do período` : ""}
      </small>}
    </div>
    {batch.status === "pending" && !isManual && <button className="approve-button" disabled={busy} onClick={(event) => {
      event.stopPropagation(); onApprove();
    }}><CheckCircle2 size={15}/> Incorporar ao histórico</button>}
  </article>;
}

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const requestId = useRef(0);
  const botRequestInProgress = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pdfInput = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<"analysis" | "history" | "bases">("analysis");
  const [historyScope, setHistoryScope] = useState<HistoryScope>("strict");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [clients, setClients] = useState<CatalogItem[]>([]);
  const [costCenters, setCostCenters] = useState<CatalogItem[]>([]);
  const [destinations, setDestinations] = useState<CatalogItem[]>([]);
  const [clientGroup, setClientGroup] = useState("");
  const [costCenter, setCostCenter] = useState("");
  const [destinationCode, setDestinationCode] = useState("");
  const [analysis, setAnalysis] = useState<BatchAnalysisResult | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<AnalyzedRecord | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importName, setImportName] = useState("");
  const [periodicity, setPeriodicity] = useState<Periodicity>("weekly");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [scenarioValue, setScenarioValue] = useState("");
  const [scenarioWeight, setScenarioWeight] = useState("");
  const [pdfDraft, setPdfDraft] = useState<PdfDraft | null>(null);
  const [pdfReading, setPdfReading] = useState(false);

  const request = (message: WorkerRequestMessage, transfer: Transferable[] = []) => {
    const id = ++requestId.current;
    return new Promise<WorkerResponse>((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      workerRef.current?.postMessage({ ...message, id }, transfer);
    });
  };

  const applyState = (nextSummary: DashboardSummary, nextBatches: BatchSummary[]) => {
    setSummary(nextSummary);
    setBatches(nextBatches);
    setSelectedBatchId((current) => current && nextBatches.some((item) => item.id === current)
      ? current : (nextBatches.find((item) => item.status === "pending") ?? nextBatches[0])?.id ?? "");
  };

  const analyzeAndMaybeSave = async (
    draft: PdfDraft | null,
    selectedClientGroup: string,
    selectedCostCenter: string,
    selectedDestinationCode: string,
    selectedDestinationName: string,
    value: number,
    weight: number,
  ) => {
    let wasDuplicate = false;
    const response = await request({
      type: "analyzeScenario",
      clientGroup: selectedClientGroup,
      costCenter: selectedCostCenter,
      destinationCode: selectedDestinationCode,
      value,
      weight,
      eventDate: draft?.eventDate || undefined,
      process: draft?.documentNumber || undefined,
      reimbursement: draft?.reimbursementCategory,
    });
    if (!response.ok || response.type !== "batchAnalysis") {
      throw new Error("Resposta inesperada da análise.");
    }

    if (draft) {
      try {
        const saved = await request({
          type: "manualImport",
          name: `LCD ${draft.documentType} ${draft.branch}/${draft.documentNumber}`.trim(),
          fileName: draft.fileName,
          periodicity: "daily",
          periodStart: draft.eventDate,
          periodEnd: draft.eventDate,
          status: "approved",
          records: [{
            eventDate: draft.eventDate,
            branch: draft.branch,
            documentType: draft.documentType,
            process: draft.documentNumber,
            costCenter: selectedCostCenter,
            clientCode: draft.matchedClientCode || selectedClientGroup,
            clientName: draft.clientName,
            destinationCode: selectedDestinationCode,
            destinationName: draft.destinationName || selectedDestinationName || selectedDestinationCode,
            weight,
            value,
            reimbursement: draft.reimbursementCategory,
          }],
        });
        if (!saved.ok || saved.type !== "imported") throw new Error("Resposta inesperada ao salvar o LCD.");
        applyState(saved.summary, saved.batches);
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : "Não foi possível salvar o LCD.";
        if (!message.includes("já existem")) throw saveError;
        wasDuplicate = true;
      }
    }
    return { result: response.result, wasDuplicate };
  };

  const analyzeBotPdf = async (file: File) => {
    const extracted = await extractPdfData(file);
    if (!extracted.eventDate || !extracted.documentType || !extracted.branch) {
      throw new Error("Data, tipo de documento ou filial nao foram identificados no PDF.");
    }
    if (extracted.value <= 0 || extracted.weight <= 0) {
      throw new Error("Valor ou peso nao foram identificados no PDF.");
    }

    const clientCatalog = await request({ type: "historyCatalog" });
    if (!clientCatalog.ok || clientCatalog.type !== "catalog") throw new Error("Catálogo de clientes indisponível.");
    const client = catalogMatch(extracted.clientName, clientCatalog.clients);
    if (!client) throw new Error(`Cliente nao identificado no historico: ${extracted.clientName || "nao informado"}.`);

    const costCenterCatalog = await request({ type: "historyCatalog", clientGroup: client.code });
    if (!costCenterCatalog.ok || costCenterCatalog.type !== "catalog") throw new Error("Catálogo de centros de custo indisponível.");
    const matchedCostCenter = exactCatalogMatch(extracted.costCenter, costCenterCatalog.costCenters);
    if (!matchedCostCenter) throw new Error(`Centro de custo nao identificado no historico: ${extracted.costCenter || "nao informado"}.`);

    const destinationCatalog = await request({
      type: "historyCatalog", clientGroup: client.code, costCenter: matchedCostCenter.code,
    });
    if (!destinationCatalog.ok || destinationCatalog.type !== "catalog") throw new Error("Catálogo de destinatários indisponível.");
    const destination = exactCatalogMatch(extracted.destinationCode, destinationCatalog.destinations)
      ?? catalogMatch(extracted.destinationName, destinationCatalog.destinations);
    if (!destination) {
      throw new Error(`Destinatario nao identificado no historico: ${extracted.destinationCode || extracted.destinationName || "nao informado"}.`);
    }

    const draft: PdfDraft = { ...extracted, matchedClientCode: client.code };
    return analyzeAndMaybeSave(
      draft,
      client.code,
      matchedCostCenter.code,
      destination.code,
      destination.name,
      extracted.value,
      extracted.weight,
    );
  };

  useEffect(() => {
    let active = true;
    const worker = new Worker(new URL("./analytics.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = async (event: MessageEvent<WorkerResponse | StorageBridgeRequest>) => {
      if ("bridge" in event.data) {
        try {
          const result = await handleStorageRequest(event.data);
          worker.postMessage({ bridge: "storage-response", bridgeId: event.data.bridgeId, ok: true, result });
        } catch (reason) {
          worker.postMessage({ bridge: "storage-response", bridgeId: event.data.bridgeId, ok: false,
            error: reason instanceof Error ? reason.message : "Falha no armazenamento local." });
        }
        return;
      }
      const pending = pendingRef.current.get(event.data.id);
      if (!pending) return;
      pendingRef.current.delete(event.data.id);
      event.data.ok ? pending.resolve(event.data) : pending.reject(new Error(event.data.error));
    };
    worker.onerror = () => { if (active) { setError("O processador local de dados foi interrompido."); setBusy(false); } };
    (async () => {
      try {
        const synchronization = await request({ type: "setGroupOverrides", overrides: loadGroupOverrides() });
        if (!synchronization.ok || synchronization.type !== "groupsUpdated")
          throw new Error("Não foi possível preparar os agrupamentos de clientes.");
        let response = await request({ type: "init" });
        if (!response.ok || response.type !== "state") throw new Error("Resposta inesperada do banco local.");
        if (!response.batches.length) {
          const source = await fetch("./Descargas.xlsx");
          if (!source.ok) throw new Error("Base histórica padrão não encontrada.");
          const buffer = await source.arrayBuffer();
          response = await request({ type: "import", fileName: "Descargas.xlsx", name: "Base histórica inicial",
            periodicity: "historical", status: "approved", buffer }, [buffer]);
          if (!response.ok || response.type !== "imported") throw new Error("Não foi possível criar a base histórica inicial.");
          localStorage.setItem("app-descarga-reimbursement-backfill-v1", "done");
          localStorage.setItem("app-descarga-cost-center-backfill-v1", "done");
          localStorage.setItem("app-descarga-financial-backfill-v1", "done");
        } else if (localStorage.getItem("app-descarga-reimbursement-backfill-v1") !== "done"
          || localStorage.getItem("app-descarga-cost-center-backfill-v1") !== "done"
          || localStorage.getItem("app-descarga-financial-backfill-v1") !== "done") {
          const source = await fetch("./Descargas.xlsx");
          if (!source.ok) throw new Error("Base histórica padrão não encontrada para atualizar as classificações.");
          const buffer = await source.arrayBuffer();
          if (localStorage.getItem("app-descarga-reimbursement-backfill-v1") !== "done") {
            const reimbursementBuffer = buffer.slice(0);
            const backfill = await request({ type: "backfillReimbursement", buffer: reimbursementBuffer }, [reimbursementBuffer]);
            if (!backfill.ok || backfill.type !== "backfilled") throw new Error("Não foi possível atualizar a classificação REEMB?.");
            localStorage.setItem("app-descarga-reimbursement-backfill-v1", "done");
          }
          if (localStorage.getItem("app-descarga-cost-center-backfill-v1") !== "done") {
            const costCenterBuffer = buffer.slice(0);
            const costCenterBackfill = await request({ type: "backfillCostCenters", buffer: costCenterBuffer }, [costCenterBuffer]);
            if (!costCenterBackfill.ok || costCenterBackfill.type !== "costCentersBackfilled")
              throw new Error("Não foi possível atualizar os centros de custo.");
            localStorage.setItem("app-descarga-cost-center-backfill-v1", "done");
          }
          if (localStorage.getItem("app-descarga-financial-backfill-v1") !== "done") {
            const financialBackfill = await request({ type: "backfillFinancials", buffer }, [buffer]);
            if (!financialBackfill.ok || financialBackfill.type !== "financialsBackfilled")
              throw new Error("Não foi possível atualizar os valores recebidos e status.");
            localStorage.setItem("app-descarga-financial-backfill-v1", "done");
          }
        }
        if (active && (response.type === "state" || response.type === "imported")) applyState(response.summary, response.batches);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Falha ao preparar o banco local.");
      } finally { if (active) setBusy(false); }
    })();
    return () => {
      active = false;
      worker.terminate();
      pendingRef.current.forEach(({ reject }) => reject(new Error("Processamento encerrado.")));
      pendingRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (busy || !botIntegrationAvailable()) return;
    let active = true;

    const processNextBotRequest = async () => {
      if (!active || botRequestInProgress.current || !workerRef.current) return;
      botRequestInProgress.current = true;
      let requestId = "";
      try {
        const botRequest = await claimBotRequest();
        if (!botRequest) return;
        requestId = botRequest.requestId;
        const bytes = new Uint8Array(botRequest.pdfBytes);
        const file = new File([bytes.buffer], botRequest.fileName, { type: "application/pdf" });
        const completed = await analyzeBotPdf(file);
        const analyzed = completed.result.items[0];
        if (!analyzed) throw new Error("A analise nao retornou um registro.");
        await completeBotRequest(requestId, {
          score: analyzed.result.confidenceScore.score,
          resultado: botResult(analyzed.result.overallStatus),
        });
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : "Falha desconhecida na analise automatica.";
        if (requestId) {
          try {
            await completeBotRequest(requestId, { score: null, resultado: "ERRO_NA_ANALISE" }, detail);
          } catch (completionError) {
            console.error("Falha ao responder ao bot.", completionError);
          }
        } else {
          console.error("Falha ao consultar a fila do bot.", reason);
        }
      } finally {
        botRequestInProgress.current = false;
      }
    };

    void processNextBotRequest();
    const timer = window.setInterval(() => { void processNextBotRequest(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy]);

  useEffect(() => {
    if (view !== "analysis") return;
    if (!workerRef.current) return;
    setClientGroup(""); setCostCenter(""); setDestinationCode(""); setAnalysis(null); setSelectedRecord(null);
    setScenarioValue(""); setScenarioWeight(""); setCostCenters([]); setDestinations([]);
    setPdfDraft(null); setPdfReading(false);
    if (pdfInput.current) pdfInput.current.value = "";
    request({ type: "historyCatalog" }).then((response) => {
      if (response.ok && response.type === "catalog") setClients(response.clients);
    }).catch((reason) => setError(reason.message));
  }, [view]);

  useEffect(() => {
    if (view !== "analysis") return;
    if (!clientGroup || !workerRef.current) { setCostCenters([]); setDestinations([]); return; }
    setCostCenter(""); setDestinationCode(""); setAnalysis(null); setSelectedRecord(null);
    request({ type: "historyCatalog", clientGroup }).then((response) => {
      if (response.ok && response.type === "catalog") {
        setCostCenters(response.costCenters);
        if (pdfDraft?.matchedClientCode === clientGroup && pdfDraft.costCenter) {
          const match = exactCatalogMatch(pdfDraft.costCenter, response.costCenters);
          if (match) setCostCenter(match.code);
        }
      }
    }).catch((reason) => setError(reason.message));
  }, [clientGroup, view, pdfDraft]);

  useEffect(() => {
    if (view !== "analysis") return;
    if (!clientGroup || !costCenter || !workerRef.current) { setDestinations([]); return; }
    setDestinationCode(""); setAnalysis(null); setSelectedRecord(null);
    request({ type: "historyCatalog", clientGroup, costCenter }).then((response) => {
      if (response.ok && response.type === "catalog") {
        setDestinations(response.destinations);
        if (pdfDraft && pdfDraft.matchedClientCode === clientGroup) {
          const matchByCode = exactCatalogMatch(pdfDraft.destinationCode, response.destinations);
          const matchByName = catalogMatch(pdfDraft.destinationName, response.destinations);
          const match = matchByCode ?? matchByName;
          if (match) setDestinationCode(match.code);
        }
      }
    }).catch((reason) => setError(reason.message));
  }, [clientGroup, costCenter, view, pdfDraft]);

  useEffect(() => {
    if (!pdfDraft?.clientName || pdfDraft.matchedClientCode || !clients.length) return;
    const clientMatch = catalogMatch(pdfDraft.clientName, clients);
    if (!clientMatch) return;
    setPdfDraft((current) => current ? { ...current, matchedClientCode: clientMatch.code } : current);
    setClientGroup(clientMatch.code);
  }, [clients, pdfDraft]);

  useEffect(() => {
    if (view !== "history" || !workerRef.current) return;
    setClientGroup(""); setCostCenter(""); setDestinationCode(""); setAnalysis(null); setSelectedRecord(null);
    setCostCenters([]); setDestinations([]);
    request({ type: "historyCatalog" }).then((response) => {
      if (response.ok && response.type === "catalog") {
        setClients(response.clients); setDestinations(response.destinations);
      }
    }).catch((reason) => setError(reason.message));
  }, [view, summary]);

  useEffect(() => {
    if (view !== "history" || historyScope !== "strict" || !clientGroup || !workerRef.current) return;
    setCostCenter(""); setDestinationCode(""); setAnalysis(null); setSelectedRecord(null);
    request({ type: "historyCatalog", clientGroup }).then((response) => {
      if (response.ok && response.type === "catalog") setCostCenters(response.costCenters);
    }).catch((reason) => setError(reason.message));
  }, [view, historyScope, clientGroup]);

  useEffect(() => {
    if (view !== "history" || historyScope !== "strict" || !clientGroup || !costCenter || !workerRef.current) return;
    setDestinationCode(""); setAnalysis(null); setSelectedRecord(null);
    request({ type: "historyCatalog", clientGroup, costCenter }).then((response) => {
      if (response.ok && response.type === "catalog") setDestinations(response.destinations);
    }).catch((reason) => setError(reason.message));
  }, [view, historyScope, clientGroup, costCenter]);

  useEffect(() => {
    if (view !== "history") return;
    setClientGroup(""); setCostCenter(""); setDestinationCode("");
    setAnalysis(null); setSelectedRecord(null); setCostCenters([]);
    request({ type: "historyCatalog" }).then((response) => {
      if (response.ok && response.type === "catalog") {
        setClients(response.clients); setDestinations(response.destinations);
      }
    }).catch((reason) => setError(reason.message));
  }, [view, historyScope]);

  const clearPdfDraft = () => {
    setPdfDraft(null);
    setScenarioValue(""); setScenarioWeight("");
    setClientGroup(""); setCostCenter(""); setDestinationCode("");
    setAnalysis(null); setSelectedRecord(null); setNotice("");
    if (pdfInput.current) pdfInput.current.value = "";
  };

  const readScenarioPdf = async (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Selecione um documento no formato PDF.");
      if (pdfInput.current) pdfInput.current.value = "";
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("O PDF deve ter no máximo 20 MB.");
      if (pdfInput.current) pdfInput.current.value = "";
      return;
    }

    setPdfReading(true); setError(""); setNotice(""); setAnalysis(null); setSelectedRecord(null);
    try {
      const extracted = await extractPdfData(file);
      const clientMatch = catalogMatch(extracted.clientName, clients);
      setPdfDraft({ ...extracted, matchedClientCode: clientMatch?.code ?? "" });
      setScenarioValue(decimalInput(extracted.value));
      setScenarioWeight(decimalInput(extracted.weight));
      setClientGroup(clientMatch?.code ?? "");
      setCostCenter(""); setDestinationCode("");

      const recognized = [extracted.clientName, extracted.costCenter, extracted.destinationCode,
        extracted.destinationName, extracted.value > 0, extracted.weight > 0]
        .filter(Boolean).length;
      if (recognized === 6 && clientMatch) {
        setNotice("PDF lido. Confira os campos extraídos; o destinatário será selecionado automaticamente quando houver correspondência na base.");
      } else {
        setNotice("PDF lido parcialmente. Confira e complete os campos destacados antes de analisar.");
      }
    } catch (reason) {
      setPdfDraft(null);
      setError(reason instanceof Error ? reason.message : "Não foi possível ler o PDF.");
    } finally {
      setPdfReading(false);
    }
  };

  const runAnalysis = async () => {
    const value = inputNumber(scenarioValue);
    const weight = inputNumber(scenarioWeight);
    if (value <= 0 || weight <= 0) { setError("Informe valor e peso maiores que zero para analisar o cenário."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const destination = destinations.find((item) => item.code === destinationCode);
      const completed = await analyzeAndMaybeSave(
        pdfDraft, clientGroup, costCenter, destinationCode, destination?.name ?? "", value, weight,
      );
      setAnalysis(completed.result); setSelectedRecord(completed.result.items[0] ?? null);
      if (pdfDraft) setNotice(completed.wasDuplicate
        ? "LCD analisado. Este documento já estava cadastrado na base."
        : "LCD analisado e inserido na base histórica.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha na análise."); }
    finally { setBusy(false); }
  };

  const runHistoryAnalysis = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await request({ type: "analyzeHistory", scope: historyScope,
        clientGroup: clientGroup || undefined, costCenter: costCenter || undefined,
        destinationCode: destinationCode || undefined });
      if (!response.ok || response.type !== "batchAnalysis") throw new Error("Resposta inesperada da análise.");
      setAnalysis(response.result); setSelectedRecord(response.result.items.at(-1) ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha na análise histórica."); }
    finally { setBusy(false); }
  };

  const importBatch = async () => {
    if (!importFile || !periodStart || !periodEnd) { setError("Selecione o arquivo e informe o início e o fim do período."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const buffer = await importFile.arrayBuffer();
      const response = await request({ type: "import", fileName: importFile.name, name: importName || importFile.name,
        periodicity, periodStart, periodEnd, buffer }, [buffer]);
      if (!response.ok || response.type !== "imported") throw new Error("Resposta inesperada da importação.");
      applyState(response.summary, response.batches);
      setSelectedBatchId(response.batch.id);
      setNotice(`${number(response.batch.rowCount)} registros importados. O lote ainda não altera o histórico.`);
      setShowImport(false); setImportFile(null); setImportName(""); setPeriodStart(""); setPeriodEnd("");
      if (fileInput.current) fileInput.current.value = "";
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha na importação."); }
    finally { setBusy(false); }
  };

  const approveBatch = async (batchId: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await request({ type: "approve", batchId });
      if (!response.ok || response.type !== "approved") throw new Error("Resposta inesperada da aprovação.");
      applyState(response.summary, response.batches);
      setNotice("Lote incorporado ao histórico local com sucesso.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao aprovar o lote."); }
    finally { setBusy(false); }
  };

  const backupData = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (await createBackup()) setNotice("Backup criado com sucesso.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao criar o backup."); }
    finally { setBusy(false); }
  };

  const restoreData = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (!await restoreBackup()) return;
      if (localStorage.getItem("app-descarga-reimbursement-backfill-v1") !== "done"
        || localStorage.getItem("app-descarga-cost-center-backfill-v1") !== "done"
        || localStorage.getItem("app-descarga-financial-backfill-v1") !== "done") {
        const source = await fetch("./Descargas.xlsx");
        if (!source.ok) throw new Error("Base histórica padrão não encontrada para completar o backup restaurado.");
        const buffer = await source.arrayBuffer();
        const reimbursementBuffer = buffer.slice(0);
        const reimbursements = await request({ type: "backfillReimbursement", buffer: reimbursementBuffer }, [reimbursementBuffer]);
        if (!reimbursements.ok || reimbursements.type !== "backfilled") throw new Error("Falha ao restaurar REEMB?.");
        const centerBuffer = buffer.slice(0);
        const centers = await request({ type: "backfillCostCenters", buffer: centerBuffer }, [centerBuffer]);
        if (!centers.ok || centers.type !== "costCentersBackfilled") throw new Error("Falha ao restaurar C.C.");
        const financials = await request({ type: "backfillFinancials", buffer }, [buffer]);
        if (!financials.ok || financials.type !== "financialsBackfilled")
          throw new Error("Falha ao restaurar valores recebidos e status.");
        localStorage.setItem("app-descarga-reimbursement-backfill-v1", "done");
        localStorage.setItem("app-descarga-cost-center-backfill-v1", "done");
        localStorage.setItem("app-descarga-financial-backfill-v1", "done");
      }
      const restoredOverrides = loadGroupOverrides();
      const groupsResponse = await request({ type: "setGroupOverrides", overrides: restoredOverrides });
      if (!groupsResponse.ok || groupsResponse.type !== "groupsUpdated")
        throw new Error("Não foi possível restaurar os agrupamentos de clientes.");
      const response = await request({ type: "init" });
      if (!response.ok || response.type !== "state") throw new Error("Não foi possível recarregar o banco restaurado.");
      applyState(response.summary, response.batches);
      setAnalysis(null); setSelectedRecord(null); setClientGroup(""); setCostCenter(""); setDestinationCode("");
      setNotice("Backup restaurado com sucesso.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao restaurar o backup."); }
    finally { setBusy(false); }
  };

  const exceptional = analysis ? analysis.total - analysis.counts.expected - analysis.counts.insufficient : 0;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">D</span><span>descarga<span className="brand-dot">.</span></span></div>
      <div className="workspace-label">OPERAÇÃO LOCAL</div>
      <nav>
        <button className={`nav-item ${view === "analysis" ? "active" : ""}`} onClick={() => setView("analysis")}><LayoutDashboard size={18}/> Análises</button>
        <button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><History size={18}/> Histórico</button>
        <button className={`nav-item ${view === "bases" ? "active" : ""}`} onClick={() => setView("bases")}><Database size={18}/> Bases locais
          {!!summary?.pendingBatchCount && <span className="nav-count">{summary.pendingBatchCount}</span>}</button>
      </nav>
    </aside>
    <main className="main-content">
      <header className="topbar">
        <div><span className="eyebrow">CONTROLE OPERACIONAL</span><h1>{view === "analysis" ? "Análise de cenário" : view === "history" ? "Análise do histórico" : "Bases locais"}</h1></div>
        <div className="topbar-actions">
          {view === "bases" && <button className="primary-button" onClick={() => setShowImport(true)}><Upload size={16}/> Importar Excel</button>}
        </div>
      </header>
      <div className="content-wrap">
        {(error || notice) && <div className={`app-message ${error ? "error" : "success"}`}>
          {error ? <AlertTriangle size={17}/> : <CheckCircle2 size={17}/>}<span>{error || notice}</span>
          <button onClick={() => { setError(""); setNotice(""); }}><X size={15}/></button>
        </div>}

        {view === "bases" && <section className="metrics persistent-metrics">
          <div className="metric-card"><span>REGISTROS NO HISTÓRICO</span><strong>{number(summary?.historicalRowCount ?? 0)}</strong><small className="positive">Persistidos em {storageMode}</small></div>
          <div className="metric-card"><span>CLIENTES / DESTINATÁRIOS</span><strong>{number(summary?.clientCount ?? 0)} / {number(summary?.destinationCount ?? 0)}</strong><small className="muted">Na base aprovada</small></div>
          <div className="metric-card"><span>LOTES PARA CONFERÊNCIA</span><strong>{number(summary?.pendingBatchCount ?? 0)}</strong><small className="muted">Ainda não alteram o histórico</small></div>
        </section>}

        {view === "bases" ? <>
          <section className="backup-panel">
            <div><span className="eyebrow">PROTEÇÃO DOS DADOS</span><h2>Backup da base local</h2>
              <p>Armazenamento ativo: <strong>{storageMode}</strong>. Exporte uma cópia antes de trocar de computador ou restaurar outra base.</p></div>
            <div className="backup-actions">
              <button className="secondary-button" disabled={busy} onClick={backupData}><Download size={16}/> Criar backup</button>
              <button className="secondary-button" disabled={busy} onClick={restoreData}><RotateCcw size={16}/> Restaurar backup</button>
            </div>
          </section>
          {showImport && <section className="import-panel">
            <div className="panel-title"><div><span className="eyebrow">NOVA CARGA</span><h2>Importar lote</h2></div><button className="icon-button" onClick={() => setShowImport(false)}><X size={18}/></button></div>
            <div className="import-grid">
              <label>Nome do lote<input value={importName} onChange={(event) => setImportName(event.target.value)} placeholder="Ex.: 1ª semana de maio de 2026"/></label>
              <label>Periodicidade<select value={periodicity} onChange={(event) => {
                const next = event.target.value as Periodicity; setPeriodicity(next);
                if (periodStart) setPeriodEnd(suggestedPeriodEnd(periodStart, next));
              }}>
                <option value="daily">Diário</option><option value="weekly">Semanal</option><option value="monthly">Mensal</option>
              </select></label>
              <label>Início do período<input type="date" value={periodStart} onChange={(event) => {
                setPeriodStart(event.target.value); setPeriodEnd(suggestedPeriodEnd(event.target.value, periodicity));
              }}/></label>
              <label>Fim do período<input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)}/></label>
              <label className="file-field">Arquivo Excel<input ref={fileInput} type="file" accept=".xlsx,.xls" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}/></label>
              <button className="analyze-button import-action" disabled={busy || !importFile || !periodStart || !periodEnd} onClick={importBatch}>
                {busy ? <LoaderCircle className="spin" size={17}/> : <><Upload size={16}/> Validar e importar</>}
              </button>
            </div>
            <p className="import-help">O lote será salvo como pendente. Registros repetidos são ignorados e os dados só entram no histórico depois da sua aprovação.</p>
          </section>}
          <div className="section-heading compact"><div><span className="eyebrow">HISTÓRICO DE IMPORTAÇÕES</span><h2>Lotes armazenados no aplicativo</h2></div></div>
          <section className="batch-list">
            {batches.map((batch) => <BatchCard key={batch.id} batch={batch} selected={batch.id === selectedBatchId}
              onSelect={() => setSelectedBatchId(batch.id)} onApprove={() => approveBatch(batch.id)} busy={busy}/>)}
          </section>
        </> : view === "history" ? <>
          <div className="section-heading compact"><div><span className="eyebrow">HISTÓRICO · RECORTE DE ANÁLISE</span><h2>{historyScope === "client" ? "Analisar somente por cliente"
            : historyScope === "destination" ? "Analisar somente por destinatário" : "Analisar cliente, C.C e destinatário"}</h2></div>
            <span className="status-pill"><span/> {busy ? "Processando…" : "Histórico aprovado pronto"}</span></div>
          <section className="analysis-grid">
            <div className="form-panel">
              <label>Como deseja analisar?</label>
              <div className="history-scope-switch">
                <button type="button" className={historyScope === "strict" ? "active" : ""} onClick={() => setHistoryScope("strict")} disabled={busy}>Completa</button>
                <button type="button" className={historyScope === "client" ? "active" : ""} onClick={() => setHistoryScope("client")} disabled={busy}>Por cliente</button>
                <button type="button" className={historyScope === "destination" ? "active" : ""} onClick={() => setHistoryScope("destination")} disabled={busy}>Por destinatário</button>
              </div>
              <div className="selection-context history-context"><strong>{historyScope === "client" ? "Recorte: somente grupo de cliente"
                : historyScope === "destination" ? "Recorte: somente destinatário" : "Regra estrita: grupo de cliente + C.C + destinatário"}</strong><br/>
                {historyScope === "client" ? "Todos os centros de custo e destinatários do cliente entram nas mesmas análises."
                  : historyScope === "destination" ? "Todos os clientes e centros de custo do destinatário entram nas mesmas análises."
                  : "Códigos e variações equivalentes do cliente são unidos no nível macro. A comparação respeita o C.C e o destinatário."}</div>
              {(historyScope === "strict" || historyScope === "client") && <>
                <label>Grupo de cliente</label>
                <div className="input-wrap"><Search size={17}/><select value={clientGroup} onChange={(event) => {
                  setClientGroup(event.target.value); setAnalysis(null); setSelectedRecord(null);
                }} disabled={busy}>
                  <option value="">Selecione um grupo</option>{clients.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
                </select></div>
              </>}
              {historyScope === "strict" && <>
                <label>Centro de custo (C.C)</label>
                <select value={costCenter} onChange={(event) => { setCostCenter(event.target.value); setAnalysis(null); setSelectedRecord(null); }} disabled={!clientGroup || busy}>
                  <option value="">Selecione um C.C</option>{costCenters.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
                </select>
              </>}
              {(historyScope === "strict" || historyScope === "destination") && <>
                <label>Destinatário</label>
                <select value={destinationCode} onChange={(event) => { setDestinationCode(event.target.value); setAnalysis(null); setSelectedRecord(null); }}
                  disabled={(historyScope === "strict" && !costCenter) || busy}>
                  <option value="">Selecione um destinatário</option>{destinations.map((item) => <option key={item.code} value={item.code}>{item.code} - {item.name}</option>)}
                </select>
              </>}
              <button className="analyze-button" onClick={runHistoryAnalysis} disabled={busy
                || (historyScope === "client" ? !clientGroup : historyScope === "destination" ? !destinationCode
                  : !clientGroup || !costCenter || !destinationCode)}>
                {busy ? <LoaderCircle className="spin" size={17}/> : <>Analisar histórico <ArrowUpRight size={17}/></>}
              </button>
              <p className="form-note">A classificação usa somente valores do recorte escolhido e da mesma faixa de peso.</p>
            </div>
            <div className={`result-panel ${selectedRecord ? statusTone(selectedRecord.result.destinationRule.status) : "idle"}`}>
              {analysis && selectedRecord ? <>
                <div className="result-top result-summary"><div className="result-icon">{exceptional ? <AlertTriangle size={21}/> : <CheckCircle2 size={21}/>}</div>
                  <div><span className="eyebrow">ANÁLISE 1 · VALOR POR FAIXA DE PESO</span><h3>{analysis.historyScope === "client" ? analysis.clientName
                    : analysis.historyScope === "destination" ? analysis.destinationName
                    : `${analysis.clientName} · C.C ${analysis.costCenter || "não informado"} → ${analysis.destinationName}`}</h3></div></div>
                <div className="batch-analysis-kpis">
                  <div><span>Registros</span><strong>{analysis.total}</strong></div><div><span>Dentro do esperado</span><strong>{analysis.counts.expected}</strong></div>
                  <div><span>Com alerta</span><strong>{exceptional}</strong></div><div><span>Sem histórico anterior</span><strong>{analysis.counts.insufficient}</strong></div>
                </div>
                <p className="baseline-note">Retroanálise sobre {number(analysis.baselineCount)} registros aprovados · Regras {analysis.ruleVersion}</p>
                {analysis.valueSummary && <div className="value-summary-grid">
                  <div><span>Total pago · recorte completo</span><strong>{currency(analysis.valueSummary.totalPaid)}</strong></div>
                  <div><span>Valor médio · recorte completo</span><strong>{currency(analysis.valueSummary.average)}</strong></div>
                  <div><span>Mediana · recorte completo</span><strong>{currency(analysis.valueSummary.median)}</strong></div>
                  <div><span>Menor valor · recorte completo</span><strong>{currency(analysis.valueSummary.minimum)}</strong></div>
                  <div><span>Maior valor · recorte completo</span><strong>{currency(analysis.valueSummary.maximum)}</strong></div>
                </div>}
                <div className="record-table-wrap"><table className="record-table"><thead><tr><th>Data</th><th>Processo</th><th>Peso</th><th>Faixa</th><th>Valor</th><th>Resultado</th></tr></thead>
                  <tbody>{analysis.items.map((item) => <tr key={item.id} className={selectedRecord.id === item.id ? "active" : ""} onClick={() => setSelectedRecord(item)}>
                    <td>{date(item.eventDate)}</td><td>{item.process || "—"}</td><td>{number(item.weight)} kg</td><td>{weightBandFor(item.weight)?.label ?? "—"}</td><td>{currency(item.value)}</td>
                    <td><span className={`table-status ${statusTone(item.result.destinationRule.status)}`}>{statusLabel(item.result.destinationRule.status)}</span></td>
                  </tr>)}</tbody></table></div>
                <div className="selected-record-title"><span>Detalhes do valor selecionado</span><strong>{currency(selectedRecord.value)}</strong></div>
                <div className="rule-list"><RuleCard title={analysis.historyScope === "client" ? "Faixa de peso · Grupo de cliente"
                  : analysis.historyScope === "destination" ? "Faixa de peso · Destinatário" : "Faixa de peso · Grupo + C.C + destinatário"}
                  rule={selectedRecord.result.destinationRule}/></div>
              </> : <div className="empty-result">{busy ? <LoaderCircle className="spin" size={28}/> : <div className="empty-icon"><History size={24}/></div>}
                <h3>{busy ? "Preparando o histórico" : "Pronto para consultar"}</h3><p>Escolha o tipo de recorte e selecione os dados necessários para avaliar o histórico aprovado.</p></div>}
            </div>
          </section>
          {analysis && selectedRecord && <PriceHistoryChart analysis={analysis} selectedId={selectedRecord.id} onSelect={setSelectedRecord}/>}
          {analysis && <ReimbursementPanel analysis={analysis}/>}
          {analysis && <FinancialResultPanel analysis={analysis}/>}
          {analysis && <HistoricalInsightsPanel analysis={analysis}/>}
          {analysis && <DestinationClientsPanel analysis={analysis}/>}
        </> : <>
          <section className="analysis-grid">
            <div className="form-panel">
              <section className={`pdf-reader-card ${pdfDraft ? "ready" : ""}`}>
                <input ref={pdfInput} className="visually-hidden" type="file" accept=".pdf,application/pdf"
                  onChange={(event) => readScenarioPdf(event.target.files?.[0] ?? null)}/>
                {pdfDraft ? <>
                  <div className="pdf-reader-head">
                    <div className="pdf-reader-title"><span className="pdf-reader-icon"><CheckCircle2 size={19}/></span>
                      <div><strong>Conferir dados extraídos</strong><small>{pdfDraft.fileName}</small></div></div>
                    <button className="icon-button" type="button" aria-label="Remover PDF" onClick={clearPdfDraft}><X size={17}/></button>
                  </div>
                  <PdfExtractedFields draft={pdfDraft}/>
                  {(pdfDraft.reimbursement || pdfDraft.documentNumber || pdfDraft.eventDate) && <p className="pdf-extra-line">
                    {pdfDraft.reimbursement && <span>{pdfDraft.reimbursement}</span>}
                    {pdfDraft.documentNumber && <span>{pdfDraft.documentNumber}</span>}
                    {pdfDraft.eventDate && <span>{date(pdfDraft.eventDate)}</span>}
                  </p>}
                  {(!pdfDraft.matchedClientCode || pdfDraft.warnings.length > 0) && <div className="pdf-reader-warning">
                    <AlertTriangle size={15}/><span>{[
                      ...(!pdfDraft.matchedClientCode ? ["O cliente não foi relacionado automaticamente; selecione o grupo correto."] : []),
                      ...pdfDraft.warnings,
                    ].join(" ")}</span>
                  </div>}
                  <button className="pdf-replace-button" type="button" disabled={pdfReading}
                    onClick={() => pdfInput.current?.click()}><FileText size={15}/> Ler outro PDF</button>
                </> : <div className="pdf-reader-empty">
                  <span className="pdf-reader-icon"><FileText size={21}/></span>
                  <div><strong>Preencher pelo PDF</strong><p>Cliente, C.C, valor e peso serão lidos localmente. Confira os campos antes de analisar.</p></div>
                  <button className="secondary-button" type="button" disabled={pdfReading || busy}
                    onClick={() => pdfInput.current?.click()}>{pdfReading ? <LoaderCircle className="spin" size={16}/> : <Upload size={16}/>} {pdfReading ? "Lendo..." : "Selecionar PDF"}</button>
                </div>}
              </section>
              <label>Grupo de cliente</label>
              <div className="input-wrap"><Search size={17}/><select value={clientGroup} onChange={(event) => setClientGroup(event.target.value)} disabled={busy}>
                <option value="">Selecione um grupo</option>{clients.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select></div>
              <label>Centro de custo (C.C)</label>
              <select value={costCenter} onChange={(event) => { setCostCenter(event.target.value); setAnalysis(null); }} disabled={!clientGroup || busy}>
                <option value="">Selecione um C.C</option>{costCenters.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
              <label>Destinatário</label>
              <select value={destinationCode} onChange={(event) => { setDestinationCode(event.target.value); setAnalysis(null); }} disabled={!costCenter || busy}>
                <option value="">Selecione um destinatário</option>{destinations.map((item) => <option key={item.code} value={item.code}>{item.code} - {item.name}</option>)}
              </select>
              <div className="scenario-input-grid">
                <label>Valor da descarga (R$)<input inputMode="decimal" value={scenarioValue}
                  onChange={(event) => { setScenarioValue(event.target.value); setAnalysis(null); }} placeholder="0,00"/></label>
                <label>Peso descarregado (kg)<input inputMode="decimal" value={scenarioWeight}
                  onChange={(event) => { setScenarioWeight(event.target.value); setAnalysis(null); }} placeholder="0,00"/></label>
              </div>
              <button className="analyze-button" onClick={runAnalysis} disabled={busy || !clientGroup || !costCenter
                || !destinationCode || inputNumber(scenarioValue) <= 0 || inputNumber(scenarioWeight) <= 0
                || (!!pdfDraft && (!pdfDraft.eventDate || !pdfDraft.documentType || !pdfDraft.branch))}>
                {busy ? <LoaderCircle className="spin" size={17}/> : <>{pdfDraft ? "Salvar e analisar" : "Analisar cenário"} <ArrowUpRight size={17}/></>}
              </button>
              <p className="form-note">{pdfDraft
                ? "Ao analisar, os dados conferidos do LCD serão inseridos na base histórica."
                : "O cenário informado manualmente é apenas comparado com o histórico e não é salvo."}</p>
            </div>
            <div className={`result-panel ${selectedRecord ? statusTone(selectedRecord.result.overallStatus) : "idle"}`}>
              {analysis && selectedRecord ? <>
                <div className="result-top result-summary"><div className="result-icon">{exceptional ? <AlertTriangle size={21}/> : <CheckCircle2 size={21}/>}</div>
                  <div><span className="eyebrow">CENÁRIO ANALISADO</span><h3>{analysis.clientName} · C.C {analysis.costCenter || "não informado"} → {analysis.destinationName}</h3></div></div>
                <ConfidenceScoreCard record={selectedRecord}/>
                <div className="batch-analysis-kpis">
                  <div><span>Valor informado</span><strong>{currency(selectedRecord.value)}</strong></div>
                  <div><span>Peso informado</span><strong>{number(selectedRecord.weight)} kg</strong></div>
                  <div><span>Resultado</span><strong>{statusLabel(selectedRecord.result.overallStatus)}</strong></div>
                  <div><span>Referências do recorte</span><strong>{number(analysis.baselineCount)}</strong></div>
                </div>
                <p className="baseline-note">Referência: {number(analysis.baselineCount)} registros aprovados até {date(analysis.baselineEnd)} · Regras {analysis.ruleVersion}</p>
                {analysis.valueSummary && <div className="value-summary-grid">
                  <div><span>Total pago · recorte completo</span><strong>{currency(analysis.valueSummary.totalPaid)}</strong></div>
                  <div><span>Valor médio · recorte completo</span><strong>{currency(analysis.valueSummary.average)}</strong></div>
                  <div><span>Mediana · recorte completo</span><strong>{currency(analysis.valueSummary.median)}</strong></div>
                  <div><span>Menor valor · recorte completo</span><strong>{currency(analysis.valueSummary.minimum)}</strong></div>
                  <div><span>Maior valor · recorte completo</span><strong>{currency(analysis.valueSummary.maximum)}</strong></div>
                </div>}
                <div className="rule-list"><RuleCard title={`Análise 1 · Valor na faixa ${weightBandFor(selectedRecord.weight)?.label ?? "de peso"}`} rule={selectedRecord.result.destinationRule}/></div>
              </> : <div className="empty-result">{busy ? <LoaderCircle className="spin" size={28}/> : <div className="empty-icon"><Search size={24}/></div>}
                <h3>{busy ? "Preparando os dados" : "Pronto para analisar"}</h3><p>Leia um PDF para preencher o cenário ou informe grupo, C.C, destinatário, valor e peso manualmente.</p></div>}
            </div>
          </section>
          {analysis && selectedRecord && <PriceHistoryChart analysis={analysis} selectedId={selectedRecord.id} onSelect={setSelectedRecord}/>}
          {analysis && <ReimbursementPanel analysis={analysis}/>}
          {analysis && <FinancialResultPanel analysis={analysis}/>}
          {analysis && <HistoricalInsightsPanel analysis={analysis}/>}
        </>}
        <p className="disclaimer">Dados armazenados localmente em {storageMode}. Mantenha também os arquivos Excel originais e backups periódicos.</p>
      </div>
    </main>
  </div>;
}
