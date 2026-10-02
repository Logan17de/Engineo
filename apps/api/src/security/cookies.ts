import type { IssuedSession } from "./session.js";

export const SESSION_COOKIE = "engineo_session";
export const CSRF_COOKIE = "engineo_csrf";

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies.set(name, decodeURIComponent(value));
    }
  }

  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions & { httpOnly: boolean },
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    "SameSite=Lax",
  ];

  if (options.httpOnly) {
    attributes.push("HttpOnly");
  }
  if (options.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function issuedSessionCookies(
  session: IssuedSession,
  options: CookieOptions,
): string[] {
  return [
    serializeCookie(SESSION_COOKIE, session.token, {
      ...options,
      httpOnly: true,
    }),
    serializeCookie(CSRF_COOKIE, session.csrfToken, {
      ...options,
      httpOnly: false,
    }),
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const options = {
    secure,
    maxAgeSeconds: 0,
  };

  return [
    serializeCookie(SESSION_COOKIE, "", { ...options, httpOnly: true }),
    serializeCookie(CSRF_COOKIE, "", { ...options, httpOnly: false }),
  ];
}
