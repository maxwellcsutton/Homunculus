import { describe, it, expect } from "vitest";
import { sanitizeReply, hasToolTagLeak, recoverTypedToolCalls } from "@/loop/sanitizeReply";

// The portable lesson: looser sampling improves voice but leaks tool intent as TEXT. The engine strips the
// leak AND recovers the intent. These pure functions are the heart of that — worth pinning.

describe("sanitizeReply — tool-tag hygiene", () => {
  it("keeps ordinary prose untouched", () => {
    const t = "Sure — I moved north and grabbed the lantern. It's getting dark.";
    expect(sanitizeReply(t)).toBe(t);
    expect(hasToolTagLeak(t)).toBe(false);
  });

  it("strips a typed tool call", () => {
    const t = 'Got it.\ncurrent_moment(text="exploring the ruins")';
    expect(hasToolTagLeak(t)).toBe(true);
    expect(sanitizeReply(t)).toBe("Got it.");
  });

  it("strips a bracket-colon leak", () => {
    expect(sanitizeReply("Noted. [remember: the troll fears fire]")).toBe("Noted.");
  });

  it("strips a leaked <think> spill", () => {
    expect(sanitizeReply("<think>hmm let me see</think>The door is locked.")).toBe("The door is locked.");
  });

  it("collapses a runaway emoji wall to 3", () => {
    expect(sanitizeReply("nice 💜🌙⭐🌟💫✨")).toBe("nice 💜🌙⭐");
  });
});

describe("recoverTypedToolCalls — route the leaked intent", () => {
  it("recovers a remember(...) call", () => {
    const got = recoverTypedToolCalls('remember(content="the bridge collapses on turn 3")', ["remember", "current_moment", "forget"]);
    expect(got).toEqual([{ name: "remember", args: { content: "the bridge collapses on turn 3" } }]);
  });

  it("recovers forget(id) and current_moment via bracket form", () => {
    const got = recoverTypedToolCalls("[current_moment: regrouping] and forget(7)", ["remember", "current_moment", "forget"]);
    expect(got).toContainEqual({ name: "current_moment", args: { text: "regrouping" } });
    expect(got).toContainEqual({ name: "forget", args: { id: 7 } });
  });

  it("does NOT recover names not in the whitelist", () => {
    const got = recoverTypedToolCalls('message_user(message="hi")', ["remember", "current_moment", "forget"]);
    expect(got).toEqual([]);
  });

  it("rejects placeholder junk", () => {
    expect(recoverTypedToolCalls('remember(content="content")', ["remember"])).toEqual([]);
  });
});
