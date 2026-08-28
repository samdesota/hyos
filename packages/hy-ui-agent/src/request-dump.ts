import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GatewayRequest } from "./gateway.js";

export async function dumpInitialGatewayRequest(
  projectRoot: string,
  request: GatewayRequest,
): Promise<string | undefined> {
  if (process.env.NODE_ENV === "production") return undefined;

  const directory = join(projectRoot, ".hy-ui-agent");
  const path = join(directory, "last-initial-request.json");
  const sanitized = {
    capturedAt: new Date().toISOString(),
    screenshotOmitted: true,
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.filter((part) => part.type !== "image_url")
        : message.content,
    })),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return path;
}
