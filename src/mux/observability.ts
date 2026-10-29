import b4a from "b4a";

export function sanitizeObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeObservation);
  if (b4a.isBuffer(value)) return b4a.toString(value, "hex");
  if (value === null || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("secret") ||
      normalizedKey.includes("seed") ||
      normalizedKey.includes("token")
    ) {
      continue;
    }
    if (
      (normalizedKey === "publickey" ||
        normalizedKey === "remotepublickey") &&
      (typeof field === "string" || b4a.isBuffer(field))
    ) {
      const keyHex = b4a.isBuffer(field) ? b4a.toString(field, "hex") : field;
      sanitized[key] = keyHex.slice(0, 16);
      continue;
    }
    sanitized[key] = sanitizeObservation(field);
  }
  return sanitized;
}
