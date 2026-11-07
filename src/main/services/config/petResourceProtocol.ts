import { app, net, protocol } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertValidPetId } from "../../../shared/validation/petId";
import { pathToFileURL } from "node:url";

export const petResourceProtocol = "pet-resource";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin"
};
const previewRoots = new Map<string, string>();
const localResourceRoots = new Set(["assets", "live2d"]);
const previewResourceExtensions = new Set([
  ".json",
  ".moc",
  ".moc3",
  ".mtn",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const blockedPreviewFileNames = new Set([
  "ai-connection-transaction.json",
  "ai-connections.json",
  "pet.local.json",
  "secure-secrets.json",
  "speech.local.json"
]);

export interface ResolvedResourcePath {
  filePath: string;
  containmentRoots: string[];
}

function getPetsRootPath(): string {
  return path.join(app.getPath("userData"), "pets");
}

function decodeSafePathParts(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .map((part) => {
      if (!part || part === "." || part === ".." || /[\\/\0]/.test(part)) {
        throw new Error("Invalid pet resource path segment.");
      }

      return part;
    });
}

function assertLexicallyContained(rootPath: string, targetPath: string, message: string): void {
  const relativePath = path.relative(rootPath, targetPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(message);
  }
}

function assertPreviewResourcePath(resourceParts: string[]): void {
  const fileName = resourceParts.at(-1)?.toLowerCase() ?? "";
  const extension = path.extname(fileName);

  if (
    !previewResourceExtensions.has(extension) ||
    fileName.startsWith(".") ||
    fileName.endsWith(".local.json") ||
    blockedPreviewFileNames.has(fileName)
  ) {
    throw new Error("Unsupported preview resource path.");
  }
}

export function resolvePetResourcePathForProtocol(url: string): ResolvedResourcePath {
  const parsedUrl = new URL(url);

  if (parsedUrl.hostname === "preview") {
    const [token, ...resourceParts] = decodeSafePathParts(parsedUrl.pathname);
    const previewRootPath = token ? previewRoots.get(token) : undefined;

    if (!previewRootPath || !resourceParts.length) {
      throw new Error("Invalid preview resource path.");
    }

    assertPreviewResourcePath(resourceParts);
    const targetPath = path.resolve(previewRootPath, ...resourceParts);
    assertLexicallyContained(previewRootPath, targetPath, "Invalid preview resource path.");

    return { filePath: targetPath, containmentRoots: [previewRootPath] };
  }

  if (parsedUrl.hostname !== "local") {
    throw new Error("Invalid pet resource host.");
  }

  const [rawPetId, resourceRootName, ...resourceParts] = decodeSafePathParts(parsedUrl.pathname);

  if (
    !rawPetId ||
    !resourceRootName ||
    !resourceParts.length ||
    !localResourceRoots.has(resourceRootName)
  ) {
    throw new Error("Unsupported local pet resource path.");
  }

  const petId = assertValidPetId(rawPetId);

  const userDataPath = path.resolve(app.getPath("userData"));
  const petsRootPath = path.resolve(getPetsRootPath());
  const petDirectoryPath = path.resolve(petsRootPath, petId);
  const resourceRootPath = path.resolve(petDirectoryPath, resourceRootName);
  const targetPath = path.resolve(resourceRootPath, ...resourceParts);
  assertLexicallyContained(userDataPath, petsRootPath, "Invalid local pets root.");
  assertLexicallyContained(petsRootPath, petDirectoryPath, "Invalid pet resource directory.");
  assertLexicallyContained(petDirectoryPath, resourceRootPath, "Invalid pet resource root.");
  assertLexicallyContained(resourceRootPath, targetPath, "Invalid pet resource path.");

  return {
    filePath: targetPath,
    containmentRoots: [userDataPath, petsRootPath, petDirectoryPath, resourceRootPath]
  };
}

export async function resolveRealResourcePathForProtocol(
  resource: ResolvedResourcePath
): Promise<string> {
  const realPaths = await Promise.all(
    [...resource.containmentRoots, resource.filePath].map((filePath) => fs.realpath(filePath))
  );

  for (let index = 0; index < realPaths.length - 1; index += 1) {
    assertLexicallyContained(
      realPaths[index],
      realPaths[index + 1],
      "Pet resource symbolic link escaped its root."
    );
  }

  return realPaths.at(-1) as string;
}

export function registerPetResourcePreviewRoot(rootPath: string): string {
  const token = randomUUID();

  previewRoots.set(token, path.resolve(rootPath));

  return token;
}

export function toPetPreviewResourceUrl(token: string, rootPath: string, filePath: string): string {
  const previewRootPath = path.resolve(rootPath);
  const targetPath = path.resolve(filePath);
  const relativePath = path.relative(previewRootPath, targetPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid preview resource file path.");
  }

  return `${petResourceProtocol}://preview/${encodeURIComponent(token)}/${relativePath
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/")}`;
}

export function toPetResourceUrl(filePath: string): string {
  const petsRootPath = path.resolve(getPetsRootPath());
  const targetPath = path.resolve(filePath);
  const relativePath = path.relative(petsRootPath, targetPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Pet resource file must stay inside the local pets directory.");
  }

  return `${petResourceProtocol}://local/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function registerPetResourceProtocol(): void {
  protocol.handle(petResourceProtocol, async (request) => {
    const filePath = await resolveRealResourcePathForProtocol(
      resolvePetResourcePathForProtocol(request.url)
    );

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);

    for (const [header, value] of Object.entries(corsHeaders)) {
      headers.set(header, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  });
}
