export interface WebSearchInput {
  objective: string;
  searchQueries: readonly string[];
}

export interface WebFetchInput {
  urls: readonly string[];
  objective?: string;
}

export interface AgentWebTools {
  search(
    input: WebSearchInput,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  fetch(
    input: WebFetchInput,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

interface ParallelError {
  error?: { message?: string } | string;
  detail?: string;
}

function requireText(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  return text;
}

function requireUrls(urls: readonly string[]): string[] {
  if (urls.length === 0 || urls.length > 10) {
    throw new Error("web_fetch requires between 1 and 10 URLs");
  }
  return urls.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${url.protocol}`);
    }
    return url.toString();
  });
}

export function createParallelWebTools(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): AgentWebTools {
  const fetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://api.parallel.ai/v1").replace(
    /\/$/,
    "",
  );

  async function request(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    const result = (await response.json()) as ParallelError;
    if (!response.ok) {
      const providerMessage =
        typeof result.error === "string"
          ? result.error
          : (result.error?.message ?? result.detail ?? "Unknown error");
      throw new Error(
        `Parallel ${path} request failed (${response.status}): ${providerMessage}`,
      );
    }
    return result;
  }

  return {
    search(input, sessionId, signal) {
      const searchQueries = input.searchQueries.map((query) =>
        requireText(query, "Search query"),
      );
      if (searchQueries.length === 0 || searchQueries.length > 3) {
        throw new Error("web_search requires between 1 and 3 search queries");
      }
      return request(
        "search",
        {
          objective: requireText(input.objective, "Search objective"),
          search_queries: searchQueries,
          advanced_settings: {
            max_results: 6,
            excerpt_settings: { max_chars_per_result: 3_000 },
          },
          session_id: sessionId,
        },
        signal,
      );
    },
    fetch(input, sessionId, signal) {
      return request(
        "extract",
        {
          urls: requireUrls(input.urls),
          ...(input.objective
            ? { objective: requireText(input.objective, "Fetch objective") }
            : {}),
          max_chars_total: 30_000,
          session_id: sessionId,
        },
        signal,
      );
    },
  };
}
