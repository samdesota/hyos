export interface GatewayToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface GatewayMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: GatewayToolCall[];
}

export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  tools?: unknown[];
  tool_choice?: "auto";
  stream: false;
}

export interface GatewayTransport {
  complete(request: GatewayRequest): Promise<GatewayMessage>;
}

interface GatewayResponse {
  choices?: Array<{ message?: GatewayMessage }>;
  error?: { message?: string };
}

export function createVercelGateway(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): GatewayTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (
    options.baseUrl ?? "https://ai-gateway.vercel.sh/v1"
  ).replace(/\/$/, "");
  return {
    async complete(request) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
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
