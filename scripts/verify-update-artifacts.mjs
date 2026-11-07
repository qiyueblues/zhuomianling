import { fileURLToPath } from "node:url";
import { verifyUpdateArtifacts } from "./update-release-metadata.mjs";

try {
  await verifyUpdateArtifacts(fileURLToPath(new URL("../", import.meta.url)));
  console.log("Update artifact audit passed: current installer, SHA-512, size, blockmap and release notes match latest.yml.");
} catch (error) {
  console.error(`Update artifact audit failed: ${error instanceof Error ? error.message : "invalid update artifacts"}`);
  process.exit(1);
}
