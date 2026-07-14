import { readFile } from "node:fs/promises";

export const handoffStates = [
  "offered",
  "accepted",
  "result_returned",
  "verified",
  "rework_requested",
  "closed",
  "declined",
  "expired",
  "cancelled",
  "transferred",
] as const;

export type HandoffState = (typeof handoffStates)[number];
export type TransitionEffect = Readonly<Record<string, string>>;

export interface LifecycleTransition {
  readonly interaction: string;
  readonly from: readonly (HandoffState | null)[];
  readonly to: HandoffState;
  readonly required_conditions: readonly string[];
  readonly event_type: string;
  readonly effects: readonly TransitionEffect[];
}

export interface LifecycleModel {
  readonly spec_version: "1.0";
  readonly name: string;
  readonly initial_state: HandoffState;
  readonly states: readonly HandoffState[];
  readonly terminal_states: readonly HandoffState[];
  readonly transitions: readonly LifecycleTransition[];
}

export interface TransitionResult {
  readonly previous_state: HandoffState | null;
  readonly next_state: HandoffState;
  readonly interaction: string;
  readonly event_type: string;
  readonly effects: readonly TransitionEffect[];
}

const stateSet = new Set<string>(handoffStates);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLifecycleModel(value: unknown): asserts value is LifecycleModel {
  if (!isRecord(value) || value.spec_version !== "1.0") {
    throw new Error("Lifecycle model must declare spec_version 1.0");
  }
  if (
    typeof value.name !== "string" ||
    !stateSet.has(String(value.initial_state)) ||
    !Array.isArray(value.states) ||
    !Array.isArray(value.terminal_states) ||
    !Array.isArray(value.transitions)
  ) {
    throw new Error("Lifecycle model has an invalid top-level structure");
  }

  const declaredStates = new Set(value.states);
  for (const state of handoffStates) {
    if (!declaredStates.has(state)) {
      throw new Error(`Lifecycle model is missing state ${state}`);
    }
  }

  for (const transition of value.transitions) {
    if (
      !isRecord(transition) ||
      typeof transition.interaction !== "string" ||
      !Array.isArray(transition.from) ||
      !stateSet.has(String(transition.to)) ||
      !Array.isArray(transition.required_conditions) ||
      typeof transition.event_type !== "string" ||
      !Array.isArray(transition.effects)
    ) {
      throw new Error("Lifecycle model contains an invalid transition");
    }
  }
}

export async function loadLifecycle(path: string): Promise<LifecycleModel> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertLifecycleModel(parsed);
  return parsed;
}

export function findTransition(
  model: LifecycleModel,
  state: HandoffState | null,
  interaction: string,
): LifecycleTransition | undefined {
  return model.transitions.find(
    (transition) =>
      transition.interaction === interaction && transition.from.includes(state),
  );
}

export function applyTransition(
  model: LifecycleModel,
  state: HandoffState | null,
  interaction: string,
  satisfiedConditions: ReadonlySet<string> = new Set(),
): TransitionResult {
  if (state !== null && model.terminal_states.includes(state)) {
    throw new Error(`Cannot apply ${interaction} to terminal state ${state}`);
  }

  const transition = findTransition(model, state, interaction);
  if (transition === undefined) {
    const knownInteraction = model.transitions.some(
      (candidate) => candidate.interaction === interaction,
    );
    if (!knownInteraction) {
      throw new Error(`Unknown lifecycle interaction: ${interaction}`);
    }
    throw new Error(`${interaction} is not allowed from ${state ?? "no state"}`);
  }

  const missing = transition.required_conditions.filter(
    (condition) => !satisfiedConditions.has(condition),
  );
  if (missing.length > 0) {
    throw new Error(`Missing required conditions: ${missing.join(", ")}`);
  }

  return {
    previous_state: state,
    next_state: transition.to,
    interaction,
    event_type: transition.event_type,
    effects: transition.effects,
  };
}
