export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) throw new HttpError(416, "Invalid byte range.");
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new HttpError(416, "Invalid byte range.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    throw new HttpError(416, "Requested byte range is outside the asset.");
  }
  return { start, end: Math.min(end, size - 1) };
}

export function readJsonBody(request, maxBytes = 65_536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes.`));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

export function allowedOrigin(origin, allowedOrigins) {
  return !origin || allowedOrigins.has(origin);
}
