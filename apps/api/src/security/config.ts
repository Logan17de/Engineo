/** Fail startup instead of running production sessions with development defaults. */
export function validateSecurityConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.COOKIE_SECURE === "false") {
    throw new Error("Production session cookies require Secure");
  }
  const origin = process.env.APP_ORIGIN;
  if (!origin) throw new Error("APP_ORIGIN is required in production");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("APP_ORIGIN must be an HTTPS origin");
  }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("APP_ORIGIN must be an HTTPS origin without credentials, path or query");
  }
}
