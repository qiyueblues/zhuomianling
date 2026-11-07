import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGptSoVitsEndpoint,
  getGptSoVitsBaseUrl,
  resetGptSoVitsRuntimeEndpoints
} from "./gptSoVitsRuntime";

afterEach(() => {
  resetGptSoVitsRuntimeEndpoints();
});

function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => resolve(server));
  });
}

describe("GPT-SoVITS runtime endpoints", () => {
  it("moves off an occupied preferred port and gives each pet a different endpoint", async () => {
    const occupied = await occupyPort(9880);

    try {
      const first = await ensureGptSoVitsEndpoint("pet-a");
      const second = await ensureGptSoVitsEndpoint("pet-b");

      expect(first.port).not.toBe(9880);
      expect(second.port).not.toBe(first.port);
      expect(getGptSoVitsBaseUrl("pet-a")).toBe(first.baseUrl);
      expect(getGptSoVitsBaseUrl("pet-b")).toBe(second.baseUrl);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reuses the assigned endpoint for repeated requests from one pet", async () => {
    const first = await ensureGptSoVitsEndpoint("pet-a");
    const second = await ensureGptSoVitsEndpoint("pet-a");

    expect(second).toEqual(first);
  });
});
