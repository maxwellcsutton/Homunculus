import { gameLaneTools } from "@/game/lane";
import { GAME_GUIDANCE } from "@/prompt/gameTail";
import type { Mode } from "./types";

// Build the game mode. The system prompt is the SAME frozen warm base as chat (byte-identical → the cached
// prefix is shared even when game and chat interleave on one instance), plus the optional detailed
// GAME_GUIDANCE — appended only when a distinct game lane is configured (MODEL_BASE_URL_GAME), so a single
// shared instance stays lean. The game-situational framing + run-state ride the volatile game tail folded
// into the user turn (built in src/prompt/gameTail.ts), never the cached base.
export function gameMode(baseText: string): Mode {
  const detailedGuidance = process.env.MODEL_BASE_URL_GAME ? GAME_GUIDANCE.trim() : "";
  const systemPrompt = [baseText, detailedGuidance].filter(Boolean).join("\n\n");
  return { name: "game", systemPrompt, tools: gameLaneTools() };
}
