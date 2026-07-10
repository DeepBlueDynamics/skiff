// Meridian / Nuts login (browser flow, same contract as meridian's reference
// client): redirect to auth.nuts.services/login with a return_url; the auth
// service redirects back with ?token=<JWT> appended. We stash the JWT, hand it
// to the skiff backend (which polls Meridian weather with it as Bearer), and
// decode the payload locally for display only — the services enforce.

const AUTH_BASE = 'https://auth.nuts.services';
const STORAGE_KEY = 'skiff.meridian.jwt';
// Meridian skill ids double as OAuth scopes (spec-auth).
const SCOPES = 'weather.field route.compute';

export type AuthClaims = {
  sub?: string;
  email?: string;
  scopes?: string[];
  tier?: string;
  exp?: number;
};

export function loginUrl(): string {
  // Return URL must carry NO query string: nuts-auth's OAuth callbacks append
  // "?token=..." blindly, so any existing "?" produces a malformed double-?
  // URL and the token never parses (the email flow handles it, Google/GitHub
  // don't). Scopes are currently issued server-side anyway.
  const ret = `${window.location.origin}${window.location.pathname}`;
  return `${AUTH_BASE}/login?return_url=${encodeURIComponent(ret)}`;
}

export function decodeClaims(token: string | null): AuthClaims | null {
  if (!token) return null;
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

export function storedToken(): string | null {
  const t = window.localStorage.getItem(STORAGE_KEY);
  if (!t) return null;
  const claims = decodeClaims(t);
  if (claims?.exp && claims.exp * 1000 < Date.now() + 60_000) {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return t;
}

async function pushTokenToBackend(token: string): Promise<boolean> {
  try {
    const res = await fetch('/v1/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const j = await res.json().catch(() => ({}));
    return !!j.ok;
  } catch {
    return false;
  }
}

/** Call once on app boot: absorb a ?token= callback if present, re-arm the
 *  backend with whatever valid token we hold, and return it. */
export async function initAuth(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  // Robust extraction: tolerate the malformed double-? URLs older login
  // links produce (token= buried inside another param's value).
  const fresh =
    params.get('token') ??
    window.location.href.match(/[?&]token=([\w\-.]+)/)?.[1] ??
    null;
  if (fresh) {
    window.localStorage.setItem(STORAGE_KEY, fresh);
    // Scrub the token out of the address bar. Nothing else lives in the
    // query string, so drop it wholesale (also cleans malformed double-?).
    window.history.replaceState({}, '', window.location.pathname);
  }
  const token = storedToken();
  if (token) await pushTokenToBackend(token);
  return token;
}

export function signIn(): void {
  window.location.href = loginUrl();
}

export async function signOut(): Promise<void> {
  window.localStorage.removeItem(STORAGE_KEY);
  try {
    await fetch('/v1/auth/logout', { method: 'POST' });
  } catch {}
}
