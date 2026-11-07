import concurrently from "concurrently";
import { createServer } from "vite";

let server;

try {
  server = await createServer();
  await server.listen();
  server.printUrls();

  // Read the bound port after Vite has skipped any occupied ports. Probing a
  // free port beforehand would leave a race before the server actually binds.
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("The development server did not bind a TCP port.");
  }

  const { result } = concurrently(
    [
      { name: "typescript", command: "tsc -p tsconfig.electron.json --watch" },
      {
        name: "electron",
        command: "electron .",
        env: { VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}` }
      }
    ],
    { killOthersOn: ["success", "failure"], successCondition: "first" }
  );
  await result;
} catch (error) {
  // concurrently already reports child process failures.
  if (!Array.isArray(error)) {
    console.error(error instanceof Error ? error.message : "Development startup failed.");
  }
  process.exitCode = 1;
} finally {
  await server?.close();
}
