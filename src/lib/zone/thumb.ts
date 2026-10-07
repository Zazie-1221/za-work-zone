export type ThumbResult = { thumb?: string; dominant?: string };

export function dominantHex(canvas: HTMLCanvasElement): string | undefined {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 16) {
    const alpha = data[i + 3] ?? 0;
    if (alpha < 200) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { n: number; r: number; g: number; b: number } | undefined;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }
  if (!best || best.n === 0) return;
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${hex(best.r / best.n)}${hex(best.g / best.n)}${hex(best.b / best.n)}`.toUpperCase();
}

async function dominantFromUrl(src: string): Promise<string | undefined> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, image.naturalWidth || 128);
  canvas.height = Math.max(1, image.naturalHeight || 128);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return dominantHex(canvas);
}

export async function makeThumb(file: Blob): Promise<ThumbResult> {
  if (file.type === "image/svg+xml" && file.size < 80_000) {
    const text = await file.text();
    if (text.includes("<svg")) {
      const thumb = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
      return { thumb, dominant: await dominantFromUrl(thumb) };
    }
    return {};
  }
  if (file.type && !file.type.startsWith("image/")) return {};
  try {
    const bitmap = await createImageBitmap(file);
    const max = 128;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return {};
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const dominant = dominantHex(canvas);
    const url = canvas.toDataURL("image/jpeg", 0.72);
    if (url.length > 60_000) return { dominant };
    return { thumb: url, dominant };
  } catch {
    return {};
  }
}

export async function thumbToPngBlob(src: string): Promise<Blob | null> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || 128;
  canvas.height = image.naturalHeight || 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}
