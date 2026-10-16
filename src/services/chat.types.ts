/**
 * Contrato reservado para uma futura integração de assistente.
 * Nenhum provedor de IA é inicializado nesta versão.
 */
export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type AnalyticsToolName =
  | "searchClientHistory"
  | "compareDestinationValues"
  | "listOutlierUnloads"
  | "summarizePeriod"
  | "explainClassification";

export type AnalyticsToolCall = {
  name: AnalyticsToolName;
  arguments: Record<string, string | number | boolean>;
};

export interface ChatService {
  send(message: string, context?: ChatMessage[]): AsyncIterable<ChatMessage>;
}
