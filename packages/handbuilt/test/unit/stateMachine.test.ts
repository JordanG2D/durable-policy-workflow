import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  TRANSITIONS,
  WorkflowStates,
  assertTransition,
  canTransition,
  isTerminal,
  nextState,
  progressOf,
  type WorkflowState,
} from "../../src/domain/stateMachine.js";

const happyPath: WorkflowState[] = [
  "QUOTE_REQUESTED",
  "QUOTE_PRICED",
  "POLICY_BOUND",
  "PAYMENT_CONFIRMED",
  "POLICY_ISSUED",
  "DOCUMENTS_DELIVERED",
];

describe("workflow state machine", () => {
  it("allows every happy-path step in order", () => {
    for (let i = 0; i < happyPath.length - 1; i++) {
      const from = happyPath[i]!;
      const to = happyPath[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
      expect(nextState(from)).toBe(to);
    }
  });

  it("allows dead-lettering from every non-terminal state", () => {
    for (const s of WorkflowStates) {
      expect(canTransition(s, "DEAD_LETTERED")).toBe(!isTerminal(s));
    }
  });

  it("rejects skipping steps, going backwards and self-loops", () => {
    expect(() => assertTransition("QUOTE_REQUESTED", "POLICY_BOUND")).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertTransition("POLICY_BOUND", "POLICY_ISSUED")).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertTransition("POLICY_ISSUED", "QUOTE_PRICED")).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertTransition("POLICY_BOUND", "POLICY_BOUND")).toThrow(
      IllegalTransitionError,
    );
  });

  it("allows exactly the transitions in the table, exhaustively", () => {
    let legal = 0;
    for (const from of WorkflowStates) {
      for (const to of WorkflowStates) {
        const allowed = TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
        if (allowed) {
          legal++;
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
        }
      }
    }
    // 5 forward steps + 5 dead-letter edges.
    expect(legal).toBe(10);
  });

  it("treats delivered and dead-lettered as terminal with no exits", () => {
    expect(isTerminal("DOCUMENTS_DELIVERED")).toBe(true);
    expect(isTerminal("DEAD_LETTERED")).toBe(true);
    expect(TRANSITIONS.DOCUMENTS_DELIVERED).toHaveLength(0);
    expect(TRANSITIONS.DEAD_LETTERED).toHaveLength(0);
    expect(nextState("DOCUMENTS_DELIVERED")).toBeUndefined();
  });

  it("carries from/to on the error for logging", () => {
    try {
      assertTransition("DOCUMENTS_DELIVERED", "POLICY_ISSUED");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError);
      const err = e as IllegalTransitionError;
      expect(err.from).toBe("DOCUMENTS_DELIVERED");
      expect(err.to).toBe("POLICY_ISSUED");
    }
  });

  it("orders progress along the happy path", () => {
    expect(progressOf("QUOTE_REQUESTED")).toBeLessThan(progressOf("POLICY_BOUND"));
    expect(progressOf("DEAD_LETTERED")).toBe(-1);
  });
});
