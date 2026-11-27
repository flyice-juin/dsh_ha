/** Shapes the bridge and the Home Assistant integration agree on. */

export interface DshSession {
  id: string;
  title: string | null;
  running: boolean;
  active: boolean;
  blank: boolean;
  cwd: string | null;
  updatedAt: number | null;
  agentAvailable: boolean;
  pendingInput: string[];
  queued: number;
}

export interface DshMessage {
  role: "user" | "assistant";
  type: string;
  seq: number | null;
  time: number | null;
  text: string;
}

export interface HassState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

/** The slice of the Home Assistant frontend object this panel uses. */
export interface MinimalHass {
  states: Record<string, HassState>;
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: unknown,
    returnResponse?: boolean,
  ): Promise<unknown>;
}
