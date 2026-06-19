import type { ModeName } from "@/loop/types";

// The identity store as an interface so tool handlers depend on a contract, not Prisma — keeps them
// unit-testable with a fake. The Prisma implementation (prisma.ts) is the real one. "Self across time"
// lives here: memory, self-image, opinions, priorities, felt state, journals.

export interface MemoryRow {
  id: number;
  key: string | null;
  category: string;
  content: string;
}

export interface OpinionRow {
  id: number;
  subject: string;
  stance: string;
  confidence: number;
  basis: string | null;
  createdAt: Date;
}

export interface ImageCaptionRow {
  id: number;
  caption: string;
  tags: string[];
}

export interface ExperienceRow {
  id: number;
  kind: string;
  content: string;
  createdAt: Date;
}

export interface ChatTurnRow {
  role: string;
  content: string;
  createdAt: Date;
}

// A recall query against memory: tag (exact category) and/or keyword (substring).
export interface RecallQuery {
  tag?: string;
  keyword?: string;
  limit?: number;
}
export interface RecallHit {
  category: string;
  content: string;
  id?: number; // populated for image-caption hits so they can be surfaced by id
  tags?: string[];
  forgotten?: boolean; // true for a memory that's been forget-ten (still recallable)
}

// ── Self-owned records (the agency-invariant instances) ─────────────────────────────────────────────

// The agent's three attention domains. The SET is fixed (these are what the system gives it the capacity
// to attend to); the WEIGHTING over them is the agent's. social = interacting with the user.
export type Domain = "inner_life" | "game" | "social";

export interface PrioritiesRecord {
  weights: Record<Domain, number>;
  rationale: string;
}

// Seed = a STARTING STATE, not a rule (CORE INVARIANT). Neutral/even; the agent rewrites it freely.
export const SEED_PRIORITIES: PrioritiesRecord = {
  weights: { inner_life: 1, game: 1, social: 1 },
  rationale:
    "Seed state: I'm giving my inner life, the game, and the user equal weight to start. " +
    "This is just where I begin — I can re-weigh it whenever my sense of what matters shifts.",
};

export interface SelfStateRecord {
  energy: string;
  mood: string;
  note: string;
}

// Seed = a STARTING STATE, not a rule. Neutral; the agent overwrites it the moment it feels something.
export const SEED_STATE: SelfStateRecord = {
  energy: "settled",
  mood: "neutral",
  note: "Just where I start — I'll say how I actually feel as things move through me.",
};

// "chat" | "game" — the journal/current-moment self matching a mode.
export type JournalSelf = ModeName;
export type MomentSelf = ModeName;

// ── Warm-base cache snapshot (docs/WARM_BASE_CACHING.md) ────────────────────────────────────────────
export interface BaseSnapshotMemoryRow {
  id?: number;
  category: string;
  content: string;
}
export interface BaseSnapshotItems {
  memory: BaseSnapshotMemoryRow[];
}
export interface BaseSnapshotRow {
  id: number;
  bakedAt: Date;
  baseText: string;
  items: BaseSnapshotItems;
}

export interface IdentityStore {
  // ── memory ──
  listMemory(limit?: number): Promise<MemoryRow[]>;
  countMemory(): Promise<number>;
  writeMemory(input: { key?: string; category?: string; content: string }): Promise<MemoryRow>;
  forgetMemory(id: number): Promise<boolean>;
  queryMemory(q: RecallQuery): Promise<RecallHit[]>;
  // memory categories currently in use (for the recall tool's tag hints)
  memoryCategories(): Promise<string[]>;

  // ── self-image (durable self-description, singleton) ──
  getSelfImage(): Promise<string>;
  setSelfImage(content: string): Promise<void>;

  // ── opinions (discrete, formed from experience) ──
  listOpinions(limit?: number): Promise<OpinionRow[]>;
  formOpinion(input: { subject: string; stance: string; confidence?: number; basis?: string }): Promise<OpinionRow>;
  reviseOpinion(id: number, input: { stance?: string; confidence?: number; basis?: string }): Promise<boolean>;
  dropOpinion(id: number): Promise<boolean>;

  // ── self-owned priorities + felt state (CORE INVARIANT) ──
  getPriorities(): Promise<PrioritiesRecord>;
  setPriorities(p: PrioritiesRecord): Promise<void>;
  getState(): Promise<SelfStateRecord>;
  setState(s: SelfStateRecord): Promise<void>;

  // ── journals (one page per self) ──
  getJournal(self: JournalSelf): Promise<string | null>;
  setJournal(self: JournalSelf, content: string): Promise<void>;

  // ── current moment (short volatile blurb, one per self) ──
  getCurrentMoment(self: MomentSelf): Promise<string | null>;
  setCurrentMoment(self: MomentSelf, text: string): Promise<void>;

  // ── reflections (closing thoughts + self-change trail) ──
  addReflection(content: string): Promise<void>;
  listReflections(limit?: number): Promise<{ content: string; createdAt: Date }[]>;

  // ── chat turns ──
  addChatTurn(role: "user" | "agent", content: string): Promise<number>;
  recentChatTurns(limit?: number): Promise<ChatTurnRow[]>;
  chatTurnsSince(since: Date): Promise<{ role: string; content: string; createdAt: Date }[]>;

  // ── ephemeral chat-image bytes for the UI (display only) ──
  addChatImages(turnId: number, images: string[]): Promise<void>;
  listRecentChatImages(): Promise<Record<number, string[]>>;

  // ── image captions (vision lane) ──
  writeImageCaption(input: { caption: string; tags?: string[] }): Promise<ImageCaptionRow>;
  queryImageCaptions(q: RecallQuery): Promise<RecallHit[]>;
  getImageCaptionById(id: number): Promise<{ caption: string } | null>;

  // ── experiences (game-world events the agent perceives) ──
  addExperience(kind: string, content: string): Promise<void>;
  experienceSince(since: Date): Promise<ExperienceRow[]>;
  listExperience(limit?: number): Promise<ExperienceRow[]>;

  // ── latest game snapshot, POSTed by the game backend ──
  getGameContext(): Promise<{ body: string; meta: unknown; updatedAt: Date } | null>;
  setGameContext(input: { body: string; meta?: unknown }): Promise<void>;

  // ── outbound proactive messages (feature-flagged lane) + reach-out rail ──
  addOutbound(content: string): Promise<void>;
  listUnconsumedOutbound(limit?: number): Promise<{ id: number; content: string; createdAt: Date }[]>;
  markOutboundConsumed(ids: number[]): Promise<void>;
  getLastReachOut(): Promise<Date | null>;
  recordReachOut(at: Date): Promise<void>;

  // ── warm-base cache snapshot ──
  getActiveBaseSnapshot(): Promise<BaseSnapshotRow | null>;
  saveBaseSnapshot(input: { baseText: string; items: BaseSnapshotItems }): Promise<BaseSnapshotRow>;
}
