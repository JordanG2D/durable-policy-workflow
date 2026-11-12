/**
 * The policy-issuance workflow as an explicit state machine.
 *
 * Every state change in the system goes through `assertTransition`. The table
 * below is the only place transitions are defined; anything not listed is
 * illegal and rejected.
 */

export const WorkflowStates = [
  "QUOTE_REQUESTED",
  "QUOTE_PRICED",
  "POLICY_BOUND",
  "PAYMENT_CONFIRMED",
  "POLICY_ISSUED",
  "DOCUMENTS_DELIVERED",
  "DEAD_LETTERED",
] as const;

export type WorkflowState = (typeof WorkflowStates)[number];

/** Happy-path order. Each non-terminal state may also move to DEAD_LETTERED. */
const HAPPY_PATH: readonly WorkflowState[] = [
  "QUOTE_REQUESTED",
  "QUOTE_PRICED",
  "POLICY_BOUND",
  "PAYMENT_CONFIRMED",
  "POLICY_ISSUED",
  "DOCUMENTS_DELIVERED",
];

export const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set([
  "DOCUMENTS_DELIVERED",
  "DEAD_LETTERED",
]);

export const TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  QUOTE_REQUESTED: ["QUOTE_PRICED", "DEAD_LETTERED"],
  QUOTE_PRICED: ["POLICY_BOUND", "DEAD_LETTERED"],
  POLICY_BOUND: ["PAYMENT_CONFIRMED", "DEAD_LETTERED"],
  PAYMENT_CONFIRMED: ["POLICY_ISSUED", "DEAD_LETTERED"],
  POLICY_ISSUED: ["DOCUMENTS_DELIVERED", "DEAD_LETTERED"],
  DOCUMENTS_DELIVERED: [],
  DEAD_LETTERED: [],
};

export class IllegalTransitionError extends Error {
  override readonly name = "IllegalTransitionError";
  constructor(
    readonly from: WorkflowState,
    readonly to: WorkflowState,
  ) {
    super(`illegal workflow transition ${from} -> ${to}`);
  }
}

export function isWorkflowState(value: string): value is WorkflowState {
  return (WorkflowStates as readonly string[]).includes(value);
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The next happy-path state, or undefined for terminal states. */
export function nextState(state: WorkflowState): WorkflowState | undefined {
  const i = HAPPY_PATH.indexOf(state);
  return i >= 0 && i < HAPPY_PATH.length - 1 ? HAPPY_PATH[i + 1] : undefined;
}

/**
 * Position on the happy path. Used to recognise stale events: an event that
 * expects state S is stale once the workflow has moved past S.
 */
export function progressOf(state: WorkflowState): number {
  return HAPPY_PATH.indexOf(state);
}
