/**
 * scripts/auth.ts
 *
 * Shared auth helpers importable in pre/post scripts via ctx.scripts.auth.*
 *
 * Usage in a test YAML pre-script:
 *   const token = await ctx.scripts.auth.getBearerToken(ctx.env);
 *   ctx.request.headers['Authorization'] = token;
 */

export interface EnvVars {
  AUTH_TOKEN?: string;
  AUTH_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

/**
 * Returns the configured bearer token string.
 * If the token starts with "Bearer " it's returned as-is.
 * Otherwise, "Bearer " is prepended.
 */
export function getBearerToken(env: EnvVars): string {
  const token = env.AUTH_TOKEN;
  if (!token) throw new Error('AUTH_TOKEN is not set in environment');
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

/**
 * Fetches a fresh OAuth2 client_credentials token from AUTH_URL.
 * Requires: AUTH_URL, CLIENT_ID, CLIENT_SECRET in env.
 *
 * Returns: "Bearer <access_token>"
 */
export async function fetchOAuthToken(env: EnvVars): Promise<string> {
  const { AUTH_URL, CLIENT_ID, CLIENT_SECRET } = env;
  if (!AUTH_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('fetchOAuthToken requires AUTH_URL, CLIENT_ID, CLIENT_SECRET in env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`OAuth token fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { access_token: string };
  if (!data.access_token) throw new Error('OAuth response missing access_token');
  return `Bearer ${data.access_token}`;
}
