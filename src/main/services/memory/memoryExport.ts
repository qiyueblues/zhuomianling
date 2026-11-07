export function createMemoryExportFileName(petName: string | undefined, petId: string): string {
  const name = (petName ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 80);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name);
  return `${name && !reserved ? name : petId}-memory.zmlmem`;
}
