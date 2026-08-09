import type { ExportArtifact } from '../export';

/** Shared by the side panel and the dashboard — both trigger the same download flow. */
export function downloadArtifact(artifact: ExportArtifact): void {
  const blob = new Blob([artifact.content], { type: artifact.mimeType });
  const url = URL.createObjectURL(blob);
  void chrome.downloads
    .download({ url, filename: artifact.filename, saveAs: true })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 10_000));
}
