import net from "node:net";

const gptSoVitsHost = "127.0.0.1";
const preferredGptSoVitsPort = 9880;

export interface GptSoVitsRuntimeEndpoint {
  host: string;
  port: number;
  baseUrl: string;
}

const endpointsByPet = new Map<string, GptSoVitsRuntimeEndpoint>();
let endpointAllocationQueue: Promise<void> = Promise.resolve();

function createEndpoint(port: number): GptSoVitsRuntimeEndpoint {
  return {
    host: gptSoVitsHost,
    port,
    baseUrl: `http://${gptSoVitsHost}:${port}`
  };
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available: boolean): void => {
      server.removeAllListeners();
      resolve(available);
    };

    server.once("error", () => finish(false));
    server.listen({ host: gptSoVitsHost, port }, () => {
      server.close((error) => finish(!error));
    });
  });
}

function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    const fail = (error: Error): void => {
      server.removeAllListeners();
      reject(error);
    };

    server.once("error", fail);
    server.listen({ host: gptSoVitsHost, port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        fail(new Error("无法分配 GPT-SoVITS 本地端口。"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function allocateEndpoint(): Promise<GptSoVitsRuntimeEndpoint> {
  if (await isPortAvailable(preferredGptSoVitsPort)) {
    return createEndpoint(preferredGptSoVitsPort);
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await findFreeLoopbackPort();
    if (await isPortAvailable(port)) {
      return createEndpoint(port);
    }
  }

  throw new Error("没有找到可用的 GPT-SoVITS 本地端口，请关闭占用端口的程序后重试。");
}

/** Assigns one loopback endpoint to each pet for the current main-process lifetime. */
export async function ensureGptSoVitsEndpoint(petId: string): Promise<GptSoVitsRuntimeEndpoint> {
  const normalizedPetId = petId.trim();
  if (!normalizedPetId) {
    throw new Error("缺少桌宠 ID。");
  }

  const existing = endpointsByPet.get(normalizedPetId);
  if (existing) {
    return existing;
  }

  const run = endpointAllocationQueue.then(async () => {
    const queuedExisting = endpointsByPet.get(normalizedPetId);
    if (queuedExisting) {
      return queuedExisting;
    }

    const endpoint = await allocateEndpoint();
    endpointsByPet.set(normalizedPetId, endpoint);
    return endpoint;
  });
  endpointAllocationQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Returns the endpoint assigned during this main-process lifetime. */
export function getGptSoVitsBaseUrl(petId: string): string {
  return endpointsByPet.get(petId.trim())?.baseUrl ?? createEndpoint(preferredGptSoVitsPort).baseUrl;
}

export function resetGptSoVitsRuntimeEndpoints(): void {
  endpointsByPet.clear();
  endpointAllocationQueue = Promise.resolve();
}
