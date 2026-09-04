export interface GatewayToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export type GatewayContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

export interface GatewayMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | GatewayContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: GatewayToolCall[];
}

export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  tools: unknown[];
  tool_choice: "auto";
  stream: false;
  reasoning?: { effort: GatewayReasoningEffort };
  providerOptions?: {
    gateway: {
      order: string[];
      only: string[];
    };
  };
}

export type GatewayReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function parseGatewayReasoningEffort(
  value: string | undefined,
): GatewayReasoningEffort | undefined {
  if (value === undefined || value === "") return undefined;
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as GatewayReasoningEffort;
  }
  throw new Error(`Unsupported hyedit reasoning effort: ${value}`);
}

export interface GatewayTransport {
  complete(request: GatewayRequest): Promise<GatewayMessage>;
}

interface GatewayResponse {
  choices?: Array<{ message?: GatewayMessage }>;
  error?: { message?: string };
}

export interface VercelGatewayOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
}

function networkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (!cause || typeof cause !== "object") return message;
  const code =
    "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const causeMessage =
    "message" in cause && typeof cause.message === "string"
      ? cause.message
      : undefined;
  if (!code && !causeMessage) return message;
  return `${message} (${[code, causeMessage].filter(Boolean).join(": ")})`;
}

export function createVercelGateway(
  options: VercelGatewayOptions,
): GatewayTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (
    options.baseUrl ?? "https://ai-gateway.vercel.sh/v1"
  ).replace(/\/$/, "");
  const retryDelayMs = options.retryDelayMs ?? 250;

  return {
    async complete(request) {
      let response: Response | undefined;
      let lastNetworkError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
          });
          break;
        } catch (error) {
          lastNetworkError = error;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }
      if (!response) {
        throw new Error(
          `AI Gateway network request failed after 2 attempts: ${networkFailure(lastNetworkError)}`,
          { cause: lastNetworkError },
        );
      }
      const body = (await response.json()) as GatewayResponse;

      if (!response.ok) {
        throw new Error(
          `AI Gateway request failed (${response.status}): ${body.error?.message ?? "Unknown error"}`,
        );
      }

      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("AI Gateway returned no assistant message");
      return message;
    },
  };
}
