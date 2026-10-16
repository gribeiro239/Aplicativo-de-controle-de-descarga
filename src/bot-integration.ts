import { invoke, isTauri } from "@tauri-apps/api/core";

export type BotAnalysisResponse = {
  score: number | null;
  resultado: string;
};

export type BotIntegrationRequest = {
  requestId: string;
  fileName: string;
  pdfBytes: number[];
};

export const botIntegrationAvailable = () => isTauri();

export const claimBotRequest = () =>
  invoke<BotIntegrationRequest | null>("claim_bot_request");

export const completeBotRequest = (
  requestId: string,
  response: BotAnalysisResponse,
  errorDetail?: string,
) => invoke<void>("complete_bot_request", {
  requestId,
  score: response.score,
  resultado: response.resultado,
  errorDetail: errorDetail ?? null,
});
