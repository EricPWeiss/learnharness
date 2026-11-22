import type { SourceOrganization } from "./source-organization.ts";

/** Display-only folder breadcrumbs based on the current stable folder IDs. */
export function sourceFolderBreadcrumb(
  organization: SourceOrganization | undefined,
  sourceId: string,
): string | null {
  if (!organization) return null;
  const folders = new Map(organization.folders.map(folder => [folder.id, folder]));
  let id = organization.placements[sourceId]?.folderId ?? null;
  const segments: string[] = [];
  const seen = new Set<string>();
  while (id !== null && folders.has(id) && !seen.has(id)) {
    seen.add(id);
    const folder = folders.get(id)!;
    segments.unshift(folder.name);
    id = folder.parentId;
  }
  return segments.length ? segments.join(" / ") : null;
}
