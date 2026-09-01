import { createServer } from "node:net";

export interface DevPorts {
  server: number;
  client: number;
}

async function portIsAvailable(host: string, port: number): Promise<boolean> {
  const server = createServer();
  server.unref();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function nextAvailablePort(
  host: string,
  preferred: number,
  excluded: ReadonlySet<number>,
): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65_535) {
    throw new Error(`Invalid development port: ${preferred}`);
  }
  for (let port = preferred; port <= 65_535; port += 1) {
    if (!excluded.has(port) && (await portIsAvailable(host, port))) return port;
  }
  throw new Error(`No available development port at or above ${preferred}`);
}

export async function chooseDevPorts(options: {
  host: string;
  serverPort: number;
  clientPort: number;
}): Promise<DevPorts> {
  const server = await nextAvailablePort(
    options.host,
    options.serverPort,
    new Set(),
  );
  const client = await nextAvailablePort(
    options.host,
    options.clientPort,
    new Set([server]),
  );
  return { server, client };
}
