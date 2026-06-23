import { PrismaClient, type Prisma } from "@prisma/client";
import type {
  IdentityStore,
  MemoryRow,
  OpinionRow,
  ImageCaptionRow,
  ExperienceRow,
  ChatTurnRow,
  RecallQuery,
  RecallHit,
  PrioritiesRecord,
  SelfStateRecord,
  JournalSelf,
  MomentSelf,
  BaseSnapshotItems,
  BaseSnapshotRow,
} from "./types";
import { SEED_PRIORITIES, SEED_STATE } from "./types";

// Single PrismaClient across hot reloads (Next dev re-imports modules) — a new client per import would
// exhaust DB connections. The continuous loop + the routes share this one.
const g = globalThis as unknown as { __prisma?: PrismaClient };
export const prisma = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__prisma = prisma;

const CHAT_IMAGE_TTL_MS = 24 * 60 * 60 * 1000; // display-only bytes: ~1 day

// The Prisma-backed identity store. Implements the IdentityStore contract; tool handlers depend on the
// interface, not this. "Self across time" lives here.
export const prismaStore: IdentityStore = {
  // ── memory ──
  async listMemory(limit = 500): Promise<MemoryRow[]> {
    const rows = await prisma.memory.findMany({
      where: { forgottenAt: null },
      orderBy: { id: "asc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, key: r.key, category: r.category, content: r.content }));
  },
  async countMemory(): Promise<number> {
    return prisma.memory.count({ where: { forgottenAt: null } });
  },
  async writeMemory(input): Promise<MemoryRow> {
    // Update-in-place when a stable key is reused; else insert.
    if (input.key) {
      const existing = await prisma.memory.findFirst({ where: { key: input.key, forgottenAt: null } });
      if (existing) {
        const r = await prisma.memory.update({
          where: { id: existing.id },
          data: { content: input.content, category: input.category ?? existing.category },
        });
        return { id: r.id, key: r.key, category: r.category, content: r.content };
      }
    }
    const r = await prisma.memory.create({
      data: { key: input.key, category: input.category ?? "misc", content: input.content },
    });
    return { id: r.id, key: r.key, category: r.category, content: r.content };
  },
  async forgetMemory(id): Promise<boolean> {
    const r = await prisma.memory.updateMany({ where: { id, forgottenAt: null }, data: { forgottenAt: new Date() } });
    return r.count > 0;
  },
  async queryMemory(q: RecallQuery): Promise<RecallHit[]> {
    const where: Prisma.MemoryWhereInput = {};
    if (q.tag) where.category = q.tag;
    if (q.keyword) where.content = { contains: q.keyword, mode: "insensitive" };
    const rows = await prisma.memory.findMany({ where, orderBy: { id: "desc" }, take: q.limit ?? 50 });
    return rows.map((r) => ({ category: r.category, content: r.content, forgotten: r.forgottenAt !== null }));
  },
  async memoryCategories(): Promise<string[]> {
    const rows = await prisma.memory.findMany({
      where: { forgottenAt: null },
      distinct: ["category"],
      select: { category: true },
    });
    return rows.map((r) => r.category).sort();
  },

  // ── self-image ──
  async getSelfImage(): Promise<string> {
    const r = await prisma.selfImage.findUnique({ where: { key: "current" } });
    return r?.content ?? "";
  },
  async setSelfImage(content): Promise<void> {
    await prisma.selfImage.upsert({ where: { key: "current" }, create: { key: "current", content }, update: { content } });
  },

  // ── opinions ──
  async listOpinions(limit = 50): Promise<OpinionRow[]> {
    const rows = await prisma.opinion.findMany({ where: { retiredAt: null }, orderBy: { id: "asc" }, take: limit });
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      stance: r.stance,
      confidence: r.confidence,
      basis: r.basis,
      createdAt: r.createdAt,
    }));
  },
  async formOpinion(input): Promise<OpinionRow> {
    const r = await prisma.opinion.create({
      data: {
        subject: input.subject,
        stance: input.stance,
        confidence: input.confidence ?? 0.5,
        basis: input.basis,
      },
    });
    return { id: r.id, subject: r.subject, stance: r.stance, confidence: r.confidence, basis: r.basis, createdAt: r.createdAt };
  },
  async reviseOpinion(id, input): Promise<boolean> {
    const data: Prisma.OpinionUpdateManyMutationInput = {};
    if (input.stance !== undefined) data.stance = input.stance;
    if (input.confidence !== undefined) data.confidence = input.confidence;
    if (input.basis !== undefined) data.basis = input.basis;
    const r = await prisma.opinion.updateMany({ where: { id, retiredAt: null }, data });
    return r.count > 0;
  },
  async dropOpinion(id): Promise<boolean> {
    const r = await prisma.opinion.updateMany({ where: { id, retiredAt: null }, data: { retiredAt: new Date() } });
    return r.count > 0;
  },

  // ── priorities + felt state (seed once if absent; the agent's thereafter) ──
  async getPriorities(): Promise<PrioritiesRecord> {
    const r = await prisma.priorities.findUnique({ where: { key: "current" } });
    if (!r) {
      await prisma.priorities.create({
        data: { key: "current", weights: SEED_PRIORITIES.weights, rationale: SEED_PRIORITIES.rationale },
      });
      return SEED_PRIORITIES;
    }
    return { weights: r.weights as PrioritiesRecord["weights"], rationale: r.rationale };
  },
  async setPriorities(p): Promise<void> {
    await prisma.priorities.upsert({
      where: { key: "current" },
      create: { key: "current", weights: p.weights, rationale: p.rationale },
      update: { weights: p.weights, rationale: p.rationale },
    });
  },
  async getState(): Promise<SelfStateRecord> {
    const r = await prisma.selfState.findUnique({ where: { key: "current" } });
    if (!r) {
      await prisma.selfState.create({ data: { key: "current", ...SEED_STATE } });
      return SEED_STATE;
    }
    return { energy: r.energy, mood: r.mood, note: r.note };
  },
  async setState(s): Promise<void> {
    await prisma.selfState.upsert({
      where: { key: "current" },
      create: { key: "current", ...s },
      update: { ...s },
    });
  },

  // ── journals ──
  async getJournal(self: JournalSelf): Promise<string | null> {
    const r = await prisma.journal.findUnique({ where: { self } });
    return r?.content ?? null;
  },
  async setJournal(self: JournalSelf, content): Promise<void> {
    await prisma.journal.upsert({ where: { self }, create: { self, content }, update: { content } });
  },

  // ── current moment ──
  async getCurrentMoment(self: MomentSelf): Promise<string | null> {
    const r = await prisma.currentMoment.findUnique({ where: { self } });
    return r?.text ?? null;
  },
  async setCurrentMoment(self: MomentSelf, text): Promise<void> {
    await prisma.currentMoment.upsert({ where: { self }, create: { self, text }, update: { text } });
  },

  // ── reflections ──
  async addReflection(content): Promise<void> {
    await prisma.reflection.create({ data: { content } });
  },
  async listReflections(limit = 5): Promise<{ content: string; createdAt: Date }[]> {
    const rows = await prisma.reflection.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.map((r) => ({ content: r.content, createdAt: r.createdAt }));
  },

  // ── chat turns ──
  async addChatTurn(role, content): Promise<number> {
    const r = await prisma.chatTurn.create({ data: { role, content } });
    return r.id;
  },
  async recentChatTurns(limit = 10): Promise<ChatTurnRow[]> {
    const rows = await prisma.chatTurn.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, createdAt: r.createdAt }));
  },
  async chatTurnsSince(since: Date): Promise<{ role: string; content: string; createdAt: Date }[]> {
    const rows = await prisma.chatTurn.findMany({ where: { createdAt: { gt: since } }, orderBy: { id: "asc" } });
    return rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.createdAt }));
  },

  // ── ephemeral chat images (display only) ──
  async addChatImages(turnId, images): Promise<void> {
    await prisma.chatImage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - CHAT_IMAGE_TTL_MS) } } });
    if (images.length) await prisma.chatImage.createMany({ data: images.map((data) => ({ turnId, data })) });
  },
  async listRecentChatImages(): Promise<Record<number, string[]>> {
    const rows = await prisma.chatImage.findMany({
      where: { createdAt: { gte: new Date(Date.now() - CHAT_IMAGE_TTL_MS) } },
      orderBy: { id: "asc" },
    });
    const out: Record<number, string[]> = {};
    for (const r of rows) (out[r.turnId] ??= []).push(r.data);
    return out;
  },

  // ── image captions ──
  async writeImageCaption(input): Promise<ImageCaptionRow> {
    const r = await prisma.imageCaption.create({ data: { caption: input.caption, tags: input.tags ?? [] } });
    return { id: r.id, caption: r.caption, tags: r.tags };
  },
  async queryImageCaptions(q: RecallQuery): Promise<RecallHit[]> {
    const where: Prisma.ImageCaptionWhereInput = { forgottenAt: null };
    if (q.tag) where.tags = { has: q.tag };
    if (q.keyword) where.caption = { contains: q.keyword, mode: "insensitive" };
    const rows = await prisma.imageCaption.findMany({ where, orderBy: { id: "desc" }, take: q.limit ?? 20 });
    return rows.map((r) => ({ id: r.id, category: "image", content: r.caption, tags: r.tags }));
  },
  async getImageCaptionById(id): Promise<{ caption: string } | null> {
    const r = await prisma.imageCaption.findUnique({ where: { id } });
    return r ? { caption: r.caption } : null;
  },

  // ── experiences ──
  async addExperience(kind, content): Promise<void> {
    await prisma.experience.create({ data: { kind, content } });
  },
  async experienceSince(since: Date): Promise<ExperienceRow[]> {
    const rows = await prisma.experience.findMany({ where: { createdAt: { gt: since } }, orderBy: { id: "asc" } });
    return rows.map((r) => ({ id: r.id, kind: r.kind, content: r.content, createdAt: r.createdAt }));
  },
  async listExperience(limit = 8): Promise<ExperienceRow[]> {
    const rows = await prisma.experience.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.reverse().map((r) => ({ id: r.id, kind: r.kind, content: r.content, createdAt: r.createdAt }));
  },

  // ── game context (latest snapshot from the game) ──
  async getGameContext(): Promise<{ body: string; meta: unknown; updatedAt: Date } | null> {
    const r = await prisma.gameContext.findUnique({ where: { key: "current" } });
    return r ? { body: r.body, meta: r.meta, updatedAt: r.updatedAt } : null;
  },
  async setGameContext(input): Promise<void> {
    const meta = (input.meta ?? undefined) as Prisma.InputJsonValue | undefined;
    await prisma.gameContext.upsert({
      where: { key: "current" },
      create: { key: "current", body: input.body, meta },
      update: { body: input.body, meta },
    });
  },

  // ── outbound + reach-out rail ──
  async addOutbound(content): Promise<void> {
    await prisma.outboundMessage.create({ data: { content } });
  },
  async listUnconsumedOutbound(limit = 20): Promise<{ id: number; content: string; createdAt: Date }[]> {
    const rows = await prisma.outboundMessage.findMany({
      where: { consumed: false },
      orderBy: { id: "asc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt }));
  },
  async markOutboundConsumed(ids): Promise<void> {
    if (ids.length) await prisma.outboundMessage.updateMany({ where: { id: { in: ids } }, data: { consumed: true } });
  },
  async getLastReachOut(): Promise<Date | null> {
    const r = await prisma.proactiveState.findUnique({ where: { key: "current" } });
    return r?.lastReachOut ?? null;
  },
  async recordReachOut(at: Date): Promise<void> {
    await prisma.proactiveState.upsert({
      where: { key: "current" },
      create: { key: "current", lastReachOut: at },
      update: { lastReachOut: at },
    });
  },

  // ── warm-base snapshot ──
  async getActiveBaseSnapshot(): Promise<BaseSnapshotRow | null> {
    const r = await prisma.promptBaseSnapshot.findFirst({ where: { active: true }, orderBy: { id: "desc" } });
    return r ? { id: r.id, bakedAt: r.bakedAt, baseText: r.baseText, items: r.items as unknown as BaseSnapshotItems } : null;
  },
  async saveBaseSnapshot(input): Promise<BaseSnapshotRow> {
    return prisma.$transaction(async (tx) => {
      await tx.promptBaseSnapshot.updateMany({ where: { active: true }, data: { active: false } });
      const r = await tx.promptBaseSnapshot.create({
        data: { baseText: input.baseText, items: input.items as unknown as Prisma.InputJsonValue, active: true },
      });
      return { id: r.id, bakedAt: r.bakedAt, baseText: r.baseText, items: r.items as unknown as BaseSnapshotItems };
    });
  },
};
