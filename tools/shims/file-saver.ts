/** Test shim: captures what the app would download instead of saving it. */
let last: { name: string; blob: Blob } | null = null;

export function saveAs(blob: Blob, name = "download"): void {
  last = { name, blob };
}

export function savedFile(): { name: string; blob: Blob } | null {
  return last;
}
