import type { DshMessage, DshSession, HassState, MinimalHass } from "./types";

const SESSIONS_ENTITY_PREFIX = "sensor.deepseek_harness_sessions";

/**
 * Find the summary sensor. Entity ids are user-renamable, so fall back to the
 * shape of the attributes rather than trusting the default id.
 */
export function findSessionsState(hass: MinimalHass): HassState | undefined {
  const preferred = hass.states[SESSIONS_ENTITY_PREFIX];
  if (preferred && Array.isArray(preferred.attributes.sessions)) {
    return preferred;
  }
  for (const state of Object.values(hass.states)) {
    if (!state.entity_id.startsWith("sensor.")) continue;
    if (Array.isArray(state.attributes.sessions)) return state;
  }
  return undefined;
}

function toSession(raw: unknown): DshSession | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string") return undefined;
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : null,
    running: row.running === true,
    active: row.active === true,
    blank: row.blank === true,
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
    agentAvailable: row.agentAvailable !== false,
    pendingInput: Array.isArray(row.pendingInput) ? (row.pendingInput as string[]) : [],
    queued: typeof row.queued === "number" ? row.queued : 0,
  };
}

export function readSessions(hass: MinimalHass): DshSession[] {
  const state = findSessionsState(hass);
  const rows = state?.attributes.sessions;
  if (!Array.isArray(rows)) return [];
  const sessions: DshSession[] = [];
  for (const row of rows) {
    const session = toSession(row);
    if (session) sessions.push(session);
  }
  return sessions;
}

/** A compact fingerprint of the session list, used to skip redundant renders. */
export function sessionsKey(sessions: DshSession[]): string {
  return sessions
    .map(
      (s) =>
        `${s.id}|${s.running ? 1 : 0}|${s.queued}|${s.pendingInput.length}|${s.title ?? ""}|${s.updatedAt ?? 0}`,
    )
    .join("\n");
}

/** `hass.callService(..., true)` resolves either the raw result or `{response}`. */
export function unwrapServiceResult(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) return {};
  const holder = result as Record<string, unknown>;
  const inner = holder.response;
  if (typeof inner === "object" && inner !== null) return inner as Record<string, unknown>;
  return holder;
}

export function normalizeMessages(raw: unknown): DshMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: DshMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const role = row.role === "user" ? "user" : row.role === "assistant" ? "assistant" : undefined;
    if (role === undefined) continue;
    const text = typeof row.text === "string" ? row.text : "";
    if (text.trim() === "") continue;
    messages.push({
      role,
      type: typeof row.type === "string" ? row.type : "",
      seq: typeof row.seq === "number" ? row.seq : null,
      time: typeof row.time === "number" ? row.time : null,
      text,
    });
  }
  return messages;
}

export function sameMessages(a: DshMessage[], b: DshMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].seq !== b[i].seq || a[i].role !== b[i].role || a[i].text !== b[i].text) return false;
  }
  return true;
}

export async function fetchMessages(
  hass: MinimalHass,
  sessionId: string,
  maxMessages = 30,
): Promise<DshMessage[]> {
  const result = await hass.callService(
    "dsh_harness",
    "get_messages",
    { session_id: sessionId, max_messages: maxMessages },
    undefined,
    true,
  );
  return normalizeMessages(unwrapServiceResult(result).messages);
}
