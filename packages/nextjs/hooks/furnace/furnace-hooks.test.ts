import { type AssociationState, associationKnown, needsAssociation } from "./useAssociations";
import { isSet } from "./useEngine";
import { describe, expect, it } from "vitest";

const kinds: AssociationState[] = [
  { kind: "no-account" },
  { kind: "checking" },
  { kind: "unknown", retry: () => {}, noAccount: false },
  { kind: "associated" },
  { kind: "auto" },
  { kind: "needs" },
];
const result = (fn: (s: AssociationState) => boolean) => Object.fromEntries(kinds.map(s => [s.kind, fn(s)]));

describe("association state helpers", () => {
  it("asks for an association only when the mirror node said the account needs one", () => {
    expect(result(needsAssociation)).toEqual({
      "no-account": false,
      checking: false,
      unknown: false,
      associated: false,
      auto: false,
      needs: true,
    });
  });

  it("treats checking, unknown and no-account as not yet known", () => {
    expect(result(associationKnown)).toEqual({
      "no-account": false,
      checking: false,
      unknown: false,
      associated: true,
      auto: true,
      needs: true,
    });
  });
});

describe("isSet", () => {
  it("is false only for the zero address, however it is cased", () => {
    expect(isSet("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isSet("0x0000000000000000000000000000000000A567E4")).toBe(true);
    expect(isSet("0x1565aF2C2eF52b4A89180684a47C5260c716AbD1")).toBe(true);
  });
});
