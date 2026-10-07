const files = new Map<string, File>();

export function rememberFile(id: string, file: File) {
  files.set(id, file);
}

export function recallFile(id: string): File | undefined {
  return files.get(id);
}

export function forgetFile(id: string) {
  files.delete(id);
}
