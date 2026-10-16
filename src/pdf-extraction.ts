import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { ReimbursementCategory } from "./analytics.types";
import { parseBrazilianNumber, parseBrazilianWeight } from "./number-parsing";
import { parsePdfDestination } from "./pdf-destination";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfFragment = {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
};

export type PdfFieldStatus = "identified" | "review" | "missing";

export type ExtractedPdfData = {
  fileName: string;
  clientName: string;
  costCenter: string;
  destinationName: string;
  destinationCode: string;
  weight: number;
  value: number;
  reimbursement: string;
  reimbursementCategory: ReimbursementCategory;
  eventDate: string;
  documentType: string;
  branch: string;
  documentNumber: string;
  warnings: string[];
};

const normalizedText = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, " ")
  .trim();

const nearbyValue = (fragments: PdfFragment[], labels: string[]) => {
  const normalizedLabels = labels.map(normalizedText);
  const label = fragments.find((fragment) => normalizedLabels.includes(normalizedText(fragment.text)));
  if (!label) return "";

  const onLine = fragments
    .filter((fragment) => fragment.page === label.page
      && Math.abs(fragment.y - label.y) <= 6
      && fragment.x > label.x + Math.max(label.width, 8) + 1)
    .sort((left, right) => left.x - right.x);

  if (onLine.length) {
    return onLine.map((fragment) => fragment.text.trim()).filter(Boolean).join(" ").trim();
  }

  const below = fragments
    .filter((fragment) => fragment.page === label.page
      && fragment.y < label.y - 2
      && fragment.y > label.y - 18
      && fragment.x >= label.x - 4)
    .sort((left, right) => right.y - left.y || left.x - right.x);

  return below[0]?.text.trim() ?? "";
};

const reimbursementFromFragments = (fragments: PdfFragment[]) => {
  const values = fragments.map((fragment) => normalizedText(fragment.text));
  if (values.some((value) => value.includes("NAO REEMBOLSAVEL"))) {
    return { reimbursement: "Não reembolsável", reimbursementCategory: "non-reimbursable" as const };
  }
  if (values.some((value) => value.includes("INCLUSO NO FRETE"))) {
    return { reimbursement: "Incluso no frete", reimbursementCategory: "included-in-freight" as const };
  }
  if (values.some((value) => value.includes("REEMBOLSAVEL"))) {
    return { reimbursement: "Reembolsável", reimbursementCategory: "reimbursable" as const };
  }
  return { reimbursement: "", reimbursementCategory: "not-informed" as const };
};

const parseDate = (value: string) => {
  const match = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!match) return "";
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
};

const parseDocument = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^([^:]+):\s*([^/\s]+)\s*\/(.+)$/);
  if (!match) return { documentType: "", branch: "", documentNumber: trimmed };
  return {
    documentType: match[1].trim().toUpperCase(),
    branch: match[2].trim(),
    documentNumber: match[3].trim(),
  };
};

export const extractPdfData = async (file: File): Promise<ExtractedPdfData> => {
  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const fragments: PdfFragment[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        fragments.push({
          page: pageNumber,
          text: item.str.trim(),
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
        });
      }
    }
  } finally {
    await pdf.destroy();
  }

  if (!fragments.length) {
    throw new Error("O PDF não possui texto pesquisável. Este modelo precisará de leitura por OCR.");
  }

  const clientName = nearbyValue(fragments, ["Cliente", "Cliente:"]);
  const costCenter = nearbyValue(fragments, ["CC", "CC:", "C.C", "C.C:", "Centro de custo"]);
  const destinationValue = nearbyValue(fragments, ["Destinatário", "Destinatário:", "Destinatario"]);
  const labeledDestinationCode = nearbyValue(fragments, [
    "Código destinatário", "Cód. destinatário", "Cod destinatário", "COD_DES", "Código dest",
  ]);
  const { destinationName, destinationCode } = parsePdfDestination(destinationValue, labeledDestinationCode);
  const weight = parseBrazilianWeight(nearbyValue(fragments, ["Peso", "Peso:", "Peso (kg)"]));
  const value = parseBrazilianNumber(nearbyValue(fragments, ["Valor", "Valor:", "Valor pago", "Valor descarga"]));
  const { reimbursement, reimbursementCategory } = reimbursementFromFragments(fragments);
  const eventDate = parseDate(nearbyValue(fragments, ["Data", "Data:"]));
  const document = parseDocument(nearbyValue(fragments, ["Documento", "Documento:"]));
  const warnings: string[] = [];

  if (!clientName) warnings.push("Cliente não encontrado.");
  if (!costCenter) warnings.push("Centro de custo não encontrado.");
  if (weight <= 0) warnings.push("Peso não encontrado ou inválido.");
  if (value <= 0) warnings.push("Valor não encontrado ou inválido.");
  if (!document.documentType) warnings.push("Tipo do documento não encontrado.");
  if (!document.branch) warnings.push("Filial não encontrada no documento.");
  if (!destinationCode) warnings.push("Código do destinatário (COD_DES) não encontrado.");
  if (!destinationName) warnings.push("Nome do destinatário não encontrado.");

  return {
    fileName: file.name,
    clientName,
    costCenter,
    destinationName,
    destinationCode,
    weight,
    value,
    reimbursement,
    reimbursementCategory,
    eventDate,
    ...document,
    warnings,
  };
};

export const pdfFieldStatus = (found: boolean, matched = true): PdfFieldStatus => {
  if (!found) return "missing";
  return matched ? "identified" : "review";
};

export const pdfFieldStatusLabel: Record<PdfFieldStatus, string> = {
  identified: "Identificado",
  review: "Conferir",
  missing: "Não encontrado",
};

export const normalizePdfLookup = normalizedText;
