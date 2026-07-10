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
  const cb = `${window.location.origin}${window.location.pathname}`;
  const ret = `${cb}?scope=${encodeURIComponent(SCOPES)}&scopes=${encodeURIComponent(
    SCOPES.split(' ').join(',')
  )}`;
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
  const fresh = params.get('token');
  if (fresh) {
    window.localStorage.setItem(STORAGE_KEY, fresh);
    // Scrub the token (and login scope echoes) out of the address bar.
    params.delete('token');
    params.delete('scope');
    params.delete('scopes');
    const qs = params.toString();
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (qs ? `?${qs}` : '')
    );
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
