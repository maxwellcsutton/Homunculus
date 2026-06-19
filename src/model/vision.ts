import { tlog } from "@/loop/telemetry";

// Vision lane — image → text, at the doorway. A SEPARATE llama-server instance (scripts/serveVision.ts,
// default :8083) runs a multimodal model (Qwen3-VL + its mmproj projector) and describes images. The
// caption is the ONLY thing that enters the core pipeline — Message/WireMessage stay string-only, so
// nothing downstream changes. The whole multimodal surface lives here at the edge.
//
// OFF unless VISION_BASE_URL is set: with no endpoint configured, visionEnabled() is false and
// describeImage() is a no-op (returns null). Fails OPEN everywhere: a vision-lane error never blocks a
// turn — the image just doesn't get a caption. Mirrors the embed-lane pattern (embeddings.ts).
//
// Use cases for a game-playing agent: caption an image the user attaches in chat, OR caption a game
// screenshot the game backend posts as an experience.

const visionUrl = () => (process.env.VISION_BASE_URL ?? "").trim();
const visionModel = () => process.env.VISION_MODEL ?? "qwen3-vl";
const visionMaxTokens = () => Number(process.env.VISION_MAX_TOKENS ?? "256");
const visionTemperature = () => Number(process.env.VISION_TEMPERATURE ?? "0.2");
const visionMaxImages = () => Number(process.env.VISION_MAX_IMAGES ?? "4");
const visionPrompt = () =>
  process.env.VISION_PROMPT ??
  "Describe this image concisely for someone who can't see it; note any visible text verbatim. " +
    'Then, on a separate final line, write "Tags:" followed by 3-6 short lowercase keywords ' +
    "(comma-separated) that categorize the image — its type (photo, screenshot, illustration, diagram, " +
    "ui), main subjects, and notable attributes.";

export function visionEnabled(): boolean {
  return visionUrl().length > 0;
}

// Split a VL response into the description and the trailing "Tags: a, b, c" line. No Tags line → tags is
// []. Tags are lowercased, de-hashed, trimmed, de-duped, and length/count bounded.
export function parseCaptionAndTags(raw: string): { caption: string; tags: string[] } {
  const m = raw.match(/(?:^|\n)[ \t]*tags[ \t]*:[ \t]*([^\n]+)/i);
  if (!m || m.index === undefined) return { caption: raw.trim(), tags: [] };
  const caption = raw.slice(0, m.index).trim() || raw.trim();
  const seen = new Set<string>();
  const tags = m[1]
    .split(/[,;]+/)
    .map((t) => t.trim().toLowerCase().replace(/^#/, "").replace(/\.+$/, ""))
    .filter((t) => t.length > 0 && t.length <= 32 && !seen.has(t) && !!seen.add(t))
    .slice(0, 8);
  return { caption, tags };
}

// Describe ONE image via the OpenAI-compatible /chat/completions endpoint (multimodal content). `image`
// is a data: URI or an http(s) URL — both are accepted by llama-server's image_url block. Returns the
// caption text, or null on any failure (fail open). One round-trip per image.
export async function describeImage(image: string, prompt?: string): Promise<string | null> {
  if (!visionEnabled() || !image.trim()) return null;
  const t0 = performance.now();
  try {
    const res = await fetch(`${visionUrl().replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: visionModel(),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt ?? visionPrompt() },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        max_tokens: visionMaxTokens(),
        temperature: visionTemperature(),
      }),
    });
    if (!res.ok) {
      tlog(`[vision] http ${res.status} — no caption this turn`);
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      timings?: { prompt_ms?: number; predicted_ms?: number };
    };
    const caption = json.choices?.[0]?.message?.content?.trim();
    const t = json.timings;
    tlog(
      `[vision] caption ${caption ? caption.length : 0}ch · wall=${Math.round(performance.now() - t0)}ms` +
        (t
          ? ` (encode+prefill=${Math.round(t.prompt_ms ?? 0)}ms decode=${Math.round(t.predicted_ms ?? 0)}ms)`
          : ""),
    );
    return caption && caption.length ? caption : null;
  } catch (e) {
    tlog(`[vision] error: ${String(e)} — no caption this turn`);
    return null;
  }
}

// Eager-caption helper for the chat doorway. Turns images the user attached into:
//   • `note`     — text appended to the user's message so ONLY text flows into the loop (rides along in
//                  the persisted ChatTurn → the agent's in-history copy of what the image showed).
//   • `captions` — the raw successful captions, for the caller to persist into the durable image library
//                  (queryable later via recall_images). Empty when vision is off or all fail.
// Caps at VISION_MAX_IMAGES — excess is LOGGED, never silently dropped. Fail-open: when vision is off, or
// a describe fails, it still emits a brief "an image came through but I can't see it" note so the agent
// can respond gracefully rather than be blind to the attachment.
export async function captionAttachments(
  images: string[],
): Promise<{ note: string; captions: { caption: string; tags: string[] }[] }> {
  if (!images.length) return { note: "", captions: [] };
  const use = images.slice(0, Math.max(0, visionMaxImages()));
  if (images.length > use.length) {
    tlog(`[vision] ${images.length} images attached — captioning first ${use.length} (VISION_MAX_IMAGES)`);
  }

  if (!visionEnabled()) {
    const what = images.length === 1 ? "an image" : `${images.length} images`;
    const it = images.length === 1 ? "it" : "them";
    return {
      note: `\n\n[The user attached ${what}, but the vision lane is off right now, so I can't see ${it}.]`,
      captions: [],
    };
  }

  const notes: string[] = [];
  const captions: { caption: string; tags: string[] }[] = [];
  for (let i = 0; i < use.length; i++) {
    const raw = await describeImage(use[i]);
    const label = use.length === 1 ? "an image" : `image ${i + 1}`;
    if (raw) {
      const { caption, tags } = parseCaptionAndTags(raw);
      captions.push({ caption, tags });
      notes.push(`[The user attached ${label}. It shows: ${caption}]`);
    } else {
      notes.push(`[The user attached ${label}, but I couldn't make it out this time.]`);
    }
  }
  return { note: "\n\n" + notes.join("\n"), captions };
}
