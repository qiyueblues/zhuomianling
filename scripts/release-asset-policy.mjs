const forbiddenSuffixes = [
  ".moc",
  ".moc3",
  ".model3.json",
  ".motion3.json",
  ".exp3.json",
  ".mtn",
  ".exp.json",
  ".pth",
  ".ckpt",
  ".onnx",
  ".safetensors",
  ".whl",
  ".sqlite",
  ".sqlite3",
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".aac",
  ".local.json",
  ".bak",
  ".tmp",
  ".test.js",
  ".spec.js"
];
const forbiddenFileNames = new Set([
  "pet.local.json",
  "ai-connections.json",
  "secure-secrets.json",
  "speech.local.json",
  "gpt-sovits.generated.yaml",
  ".desktop-pet-import-transaction.json"
]);
const forbiddenPathSegments = [
  "/.cache/",
  "/memory-sidecar/",
  "/gpt-sovits/",
  "/voice-model/",
  "/reference-audio/",
  "/.live2d-staging-",
  "/.live2d-backup-"
];

export function normalizeReleasePath(filePath) {
  return `/${String(filePath).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()}`;
}

export function isForbiddenReleasePath(filePath) {
  const normalizedPath = normalizeReleasePath(filePath);
  const fileName = normalizedPath.split("/").pop() ?? "";

  return (
    normalizedPath === "/dist/renderer/live2d" ||
    normalizedPath.startsWith("/dist/renderer/live2d/") ||
    forbiddenFileNames.has(fileName) ||
    forbiddenSuffixes.some((suffix) => fileName.endsWith(suffix)) ||
    forbiddenPathSegments.some((segment) => normalizedPath.includes(segment))
  );
}

export function isProductionNodeModulePath(filePath) {
  const normalizedPath = normalizeReleasePath(filePath);
  const approvedPaths = new Set([
    "/node_modules",
    "/node_modules/buffer-crc32",
    "/node_modules/buffer-crc32/license",
    "/node_modules/buffer-crc32/dist",
    "/node_modules/buffer-crc32/dist/index.cjs",
    "/node_modules/buffer-crc32/dist/index.mjs",
    "/node_modules/buffer-crc32/package.json",
    "/node_modules/pend",
    "/node_modules/pend/license",
    "/node_modules/pend/index.js",
    "/node_modules/pend/package.json",
    "/node_modules/yauzl",
    "/node_modules/yauzl/license",
    "/node_modules/yauzl/crc32.js",
    "/node_modules/yauzl/fd-slicer.js",
    "/node_modules/yauzl/index.js",
    "/node_modules/yauzl/package.json",
    "/node_modules/yazl",
    "/node_modules/yazl/license",
    "/node_modules/yazl/index.js",
    "/node_modules/yazl/package.json"
  ]);

  if (approvedPaths.has(normalizedPath)) return false;

  // Reviewed updater dependencies, restricted to their runtime entry points
  // and runtime trees. Unknown packages, CLIs, tests and source maps stay out.
  const updaterRuntimeTrees = {
    "semver": ["classes", "functions", "internal", "ranges", "index.js", "preload.js", "range.bnf"],
    "electron-updater/node_modules/semver": ["classes", "functions", "internal", "ranges", "index.js", "preload.js", "range.bnf"],
    "electron-updater": ["out"],
    "builder-util-runtime": ["out"],
    "fs-extra": ["lib"],
    "graceful-fs": ["clone.js", "graceful-fs.js", "legacy-streams.js", "polyfills.js"],
    "js-yaml": ["index.js", "lib"],
    "jsonfile": ["index.js", "utils.js"],
    "lazy-val": ["out"],
    "lodash.escaperegexp": ["index.js"],
    "lodash.isequal": ["index.js"],
    "tiny-typed-emitter": ["lib"],
    "debug": ["src"],
    "ms": ["index.js"],
    "sax": ["lib"],
    "universalify": ["index.js"],
    "argparse": ["argparse.js", "lib"]
  };
  if (normalizedPath === "/node_modules/electron-updater/node_modules") return false;
  for (const [name, runtimePaths] of Object.entries(updaterRuntimeTrees)) {
    const root = `/node_modules/${name}`;
    if (normalizedPath === root) return false;
    if (!normalizedPath.startsWith(`${root}/`)) continue;
    const relative = normalizedPath.slice(root.length + 1);
    if (/^(package\.json|licen[cs]e(?:[.-][a-z0-9]+)*|readme(?:\.md|\.txt)?|changelog\.md|history\.md)$/.test(relative)) return false;
    if (/(^|\/)(?:tests?|__tests__|examples?|fixtures|bin)(\/|\.)/.test(relative)) return true;
    if (runtimePaths.some((entry) => relative === entry || (
      !entry.includes(".") && relative.startsWith(`${entry}/`) &&
      (/\.(?:js|mjs|cjs)$/.test(relative) || !relative.split("/").pop().includes("."))
    ))) return false;
    return true;
  }
  return normalizedPath.startsWith("/node_modules");
}
