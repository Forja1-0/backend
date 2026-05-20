/**
 * Tokens efimeros que conectan WhatsApp con el web_profile.
 *
 * Flujo: el user escribe "perfil" en WhatsApp -> el bot identifica al user
 * por su JID -> issueWhatsappToken() crea un token aleatorio corto (10
 * chars sin ambiguos) con 15min de TTL -> el bot manda un mensaje con
 * `${WEB_PROFILE_URL}/login?t=<token>` -> el user toca el link -> el
 * front llama POST /api/auth/consume con el token -> consumeWhatsappToken()
 * lo marca como usado, crea una web_session de 30 dias y devuelve el
 * session_token al front.
 *
 * Decisiones de seguridad clave:
 *   - 10 chars alfanumericos sin caracteres ambiguos (64^10 ~= 1.15e18,
 *     espacio gigantesco para brute force).
 *   - Single-use: el segundo hit con el mismo token devuelve 401.
 *   - 15min TTL: si el user tarda mas, escribe "perfil" otra vez.
 *   - Al issue, invalidamos tokens previos no usados del mismo user, para
 *     que solo uno este vivo a la vez.
 *   - Validacion contra constant-time string compare no aplica porque el
 *     lookup es por columna UNIQUE en DB (no comparamos en memoria).
 *   - El session_token de web_sessions es 32 bytes random base64url
 *     (entropia >180 bits, no adivinable).
 */
import crypto from "node:crypto";
import { query, tx } from "../config/db.js";

// ── Token corto para el link de WhatsApp (visible en URL) ─────
// Alfabeto sin 0/O/1/l/I para evitar confusion visual cuando aparece en
// pantalla. Igual va dentro del link, no se tipea, pero por las dudas.
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOKEN_LEN = 10;
const TOKEN_TTL_MS = 15 * 60 * 1000;

// ── Sesion del browser ────────────────────────────────────────
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function randomToken(len: number, alphabet: string): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

/**
 * Genera un nuevo whatsapp_auth_token para el user e invalida los anteriores
 * que sigan vivos. Tx asegura que no haya ventana con dos tokens validos.
 */
export async function issueWhatsappToken(
  userId: string,
  opts: { ip?: string | null } = {},
): Promise<IssuedToken> {
  const token = randomToken(TOKEN_LEN, TOKEN_ALPHABET);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await tx(async (client) => {
    // Marca como "usados" los tokens previos vivos del mismo user. No los
    // borramos: quedan en la tabla para auditoria.
    await client.query(
      `UPDATE whatsapp_auth_tokens
         SET used_at = NOW()
       WHERE user_id = $1
         AND used_at IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO whatsapp_auth_tokens (user_id, token, expires_at, created_ip)
       VALUES ($1, $2, $3, $4)`,
      [userId, token, expiresAt, opts.ip ?? null],
    );
  });

  return { token, expiresAt };
}

export interface ConsumeResult {
  userId: string;
  sessionToken: string;
  sessionExpiresAt: Date;
}

export type ConsumeError =
  | "token_not_found"
  | "token_already_used"
  | "token_expired";

export class TokenConsumeError extends Error {
  constructor(public reason: ConsumeError) {
    super(reason);
    this.name = "TokenConsumeError";
  }
}

/**
 * Consume el token (lo marca como used) y crea una web_session. Todo en
 * una transaccion: si algo falla, no queda un token "medio usado".
 */
export async function consumeWhatsappToken(
  rawToken: string,
  opts: { ip?: string | null; userAgent?: string | null } = {},
): Promise<ConsumeResult> {
  const sessionToken = crypto.randomBytes(SESSION_BYTES).toString("base64url");
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);

  return await tx(async (client) => {
    // SELECT FOR UPDATE para evitar que dos consumes simultaneos del mismo
    // token creen dos sesiones.
    const row = await client.query<{
      id: string;
      user_id: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, used_at
         FROM whatsapp_auth_tokens
        WHERE token = $1
        FOR UPDATE`,
      [rawToken],
    );

    if (row.rowCount === 0) throw new TokenConsumeError("token_not_found");
    const t = row.rows[0];
    if (t.used_at !== null) throw new TokenConsumeError("token_already_used");
    if (new Date(t.expires_at).getTime() < Date.now())
      throw new TokenConsumeError("token_expired");

    await client.query(
      `UPDATE whatsapp_auth_tokens
          SET used_at = NOW(), used_ip = $2, used_user_agent = $3
        WHERE id = $1`,
      [t.id, opts.ip ?? null, opts.userAgent ?? null],
    );

    await client.query(
      `INSERT INTO web_sessions
         (user_id, session_token, expires_at,
          issued_ip, issued_user_agent, last_ip, last_user_agent)
       VALUES ($1, $2, $3, $4, $5, $4, $5)`,
      [t.user_id, sessionToken, sessionExpiresAt, opts.ip ?? null, opts.userAgent ?? null],
    );

    return {
      userId: t.user_id,
      sessionToken,
      sessionExpiresAt,
    };
  });
}

export interface SessionLookup {
  userId: string;
  sessionId: string;
}

/**
 * Valida un session_token y, si es valido, updatea last_seen_at/last_ip.
 * Devuelve null si la sesion no existe, expiro o fue revocada — el caller
 * (middleware) responde 401.
 */
export async function lookupSession(
  sessionToken: string,
  opts: { ip?: string | null; userAgent?: string | null } = {},
): Promise<SessionLookup | null> {
  const res = await query<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
    `SELECT id, user_id, expires_at, revoked_at
       FROM web_sessions
      WHERE session_token = $1`,
    [sessionToken],
  );
  if (res.rowCount === 0) return null;
  const s = res.rows[0];
  if (s.revoked_at !== null) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;

  // Heartbeat: refresca last_seen_at/last_ip. No bloquea el response.
  query(
    `UPDATE web_sessions
        SET last_seen_at = NOW(), last_ip = $2, last_user_agent = $3
      WHERE id = $1`,
    [s.id, opts.ip ?? null, opts.userAgent ?? null],
  ).catch(() => { /* no-op: best effort */ });

  return { userId: s.user_id, sessionId: s.id };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(`UPDATE web_sessions SET revoked_at = NOW() WHERE id = $1`, [sessionId]);
}
