import { ALL_TOOLS } from "@/tools";

// Tool-tag hygiene (plumbing, not behavior). A weak local model sometimes emits a tool call as LITERAL
// TEXT — `[remember]\n{"content":"…"}\n[/remember]`, `[think][/think]`, `remember(content="…")`, a bold
// `**current_moment**` header — instead of an actual tool_call. That text does nothing AND leaks to the
// user as a junk message. The real fix is the prompt (act through tools, never write tool-shaped tags);
// this is the defense-in-depth that strips any leak so the user never sees it and it never gets persisted
// back into history (where it would reinforce the pattern).
//
// SEPARATELY, recoverTypedToolCalls (below) RE-ROUTES a scoped, safe set of leaked text-form calls to the
// real handlers, so the intent still lands. That's the portable lesson here: looser sampling
// improves voice but degrades tool-FORMAT adherence, so parse the leaked intent and execute it, then strip
// the text. The strip lists and the recovery grammar are kept in agreement.

// RETIRED tool names still matched as leaks (history/habit can echo them).
const RETIRED = ["think", "write_vault", "write_persona", "backchannel"];

const TAG_NAMES = [...new Set([...ALL_TOOLS.map((t) => t.name), ...RETIRED])];
const NAME_ALT = TAG_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

// [name] …body… [/name] — paired tag with any (incl. multi-line JSON) body.
const PAIRED = new RegExp(`\\[(${NAME_ALT})\\b[^\\]]*\\][\\s\\S]*?\\[/\\1\\][ \\t]*\\n?`, "gi");
// [name:value] — legacy inline colon form. Strip the tag, keep the rest of the line.
const COLON = new RegExp(`\\[(?:${NAME_ALT})\\s*:[^\\]]*\\]`, "gi");
// A lone opening / closing / self-closing pseudo-tag: [name], [/name], [name ...], [name/].
const LONE = new RegExp(`\\[/?\\s*(?:${NAME_ALT})\\b[^\\]]*/?\\][ \\t]*\\n?`, "gi");

// NO-BRACKET tool-call leak: a whole line like `current_moment: …` — a tool call as plain `name: args`
// text. Scoped to DISTINCTIVE (underscored) names so a prose line like "Remember: 8pm" / "Note: …" is
// never stripped. `think` is excluded (prose risk); it's caught in the bracket forms via RETIRED.
const DISTINCTIVE = [
  ...ALL_TOOLS.map((t) => t.name).filter((n) => n.includes("_")),
  ...RETIRED.filter((n) => n !== "think"),
];
const DISTINCT_ALT = DISTINCTIVE.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const NOBRACKET_LINE = new RegExp(`^[ \\t]*(?:${DISTINCT_ALT})\\s*:.*(?:\\r?\\n|$)`, "gim");
// A whole LINE that is ONLY an underscored tool name, possibly wrapped in quotes/emphasis/brackets.
const WRAPPED_TOOLNAME_LINE = new RegExp(
  "^[ \\t\"'`*_~([]*(?:" + DISTINCT_ALT + ")[ \\t\"'`*_~)\\]!?.,:;]*(?:\\r?\\n|$)",
  "gim",
);
// PYTHON-CALL leak: `current_moment(text="…")` — a tool call written as a literal function call. Strip any
// `toolname(args)` for a DISTINCTIVE (underscored) tool name, plus optional wrapping backticks/quotes.
const FUNC_CALL = new RegExp("[`'\"*]*\\b(?:" + DISTINCT_ALT + ")\\s*\\([^)]*\\)[`'\"*]*", "gi");
// SPACE-kwargs / bare line: `current_moment text: …` — name then space-separated args (no parens).
// Underscored names only (never natural prose), so the bare form is safe.
const SPACE_ARGS_LINE = new RegExp(
  `^[ \\t]*[\`'"*]*(?:${DISTINCT_ALT})[\`'"*]*[ \\t]+(?!\\()[^\\n]*(?:\\r?\\n|$)`,
  "gim",
);
// SINGLE-WORD memory tools typed as a call — `remember(content="…")`, `forget(3)`. These names are common
// English words, so we require NO space before `(` (keeps prose like "remember (someday)" safe).
const WORD_CALL = /[`'"*]*\b(?:remember|forget)\([^)]*\)[`'"*]*/gi;

// MARKDOWN-BOLD tool-dump leak: the model writes a whole tool call as a `**current_moment**` bold header +
// body, as a message. These cluster as a TRAILING block — cut from the first such header to the end.
const BOLD_NAMES = [...new Set([...ALL_TOOLS.map((t) => t.name), ...RETIRED])]
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const BOLD_HEADER_LINE = new RegExp(`^\\s*\\*\\*(?:${BOLD_NAMES})\\*\\*\\s*(?:[—–:-]\\s*.*)?$`, "i");
function cutBoldToolDump(text: string): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => BOLD_HEADER_LINE.test(l));
  return idx === -1 ? text : lines.slice(0, idx).join("\n");
}

// ANGLE-BRACKET reasoning leak: with -rea on, llama.cpp normally extracts `<think>…</think>` into
// reasoning_content — but a runaway that hits the budget mid-block never cleanly terminates and the spilled
// reasoning lands in `content` (with a stray `</think>`). Drop everything up to and including the LAST
// `</think>`; a lone unclosed `<think>` means reasoning ran to the end — drop from it onward.
const CLOSE_THINK = /<\/think\s*>/gi;
function stripLeakedThink(text: string): string {
  let lastEnd = -1;
  for (const m of text.matchAll(CLOSE_THINK)) lastEnd = (m.index ?? 0) + m[0].length;
  const afterClose = lastEnd !== -1 ? text.slice(lastEnd) : text;
  return afterClose.replace(/<think\b[^>]*>[\s\S]*$/i, "");
}

// Runaway emoji-wall collapse: a rotating wall (💜🌙⭐🌟💫✨…) defeats both the sampler penalties (varied
// tokens) and the similarity dedup, so it's caught here. Anything OVER 3 in a row is a wall; keep the first
// 3. Normal expressive use (≤3) is untouched.
const EMOJI_CLUSTER = `\\p{Extended_Pictographic}(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}]|\\u200D\\p{Extended_Pictographic}\\uFE0F?)*`;
const EMOJI_WALL = new RegExp(`${EMOJI_CLUSTER}(?:\\s*${EMOJI_CLUSTER}){3,}`, "gu");
const EMOJI_CLUSTER_RE = new RegExp(EMOJI_CLUSTER, "gu");
function collapseEmojiWall(text: string): string {
  return text.replace(EMOJI_WALL, (run) => (run.match(EMOJI_CLUSTER_RE) ?? []).slice(0, 3).join(""));
}

// Full strip for accumulated text (final reply / persistence). Handles the multi-line paired form.
export function sanitizeReply(text: string): string {
  const stripped = stripLeakedThink(cutBoldToolDump(text))
    .replace(PAIRED, "")
    .replace(COLON, "")
    .replace(LONE, "")
    .replace(NOBRACKET_LINE, "")
    .replace(WRAPPED_TOOLNAME_LINE, "")
    .replace(SPACE_ARGS_LINE, "")
    .replace(FUNC_CALL, "")
    .replace(WORD_CALL, "");
  return collapseEmojiWall(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasToolTagLeak(text: string): boolean {
  return sanitizeReply(text) !== text.trim();
}

export { isNearDuplicate } from "./textSimilarity";

// ── TEXT-ROUTED tool recovery (the portable lesson) ─────────────────────────────────────────────────
// Parse leaked text-form tool calls for a SCOPED set of names and route them to the SAME execute path a
// real tool_call uses, so the intent lands even when the model only narrated it. NOT a general inline-tag
// executor: only the names the caller passes are recovered, and per-tool validation gates bad writes.
export interface RecoveredTypedCall {
  name: string;
  args: Record<string, unknown>;
}

type ArgVal = string | number | boolean | null;
function parseVal(raw: string): ArgVal {
  const v = raw.trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (/^(?:true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^(?:none|null)$/i.test(v)) return null;
  return v;
}

function parseArgs(argStr: string): { named: Record<string, ArgVal>; positional: ArgVal[] } {
  const named: Record<string, ArgVal> = {};
  const positional: ArgVal[] = [];
  const parts = argStr.match(/(?:[^,"']|"[^"]*"|'[^']*')+/g) ?? [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      positional.push(parseVal(part));
      continue;
    }
    named[part.slice(0, eq).trim()] = parseVal(part.slice(eq + 1));
  }
  return { named, positional };
}

const SPACE_KEY_RE = /\b(text|content|key|message|id|category|subject|stance)\s*:\s*/gi;
function parseSpaceArgs(tail: string): { named: Record<string, ArgVal>; positional: ArgVal[] } {
  const named: Record<string, ArgVal> = {};
  const positional: ArgVal[] = [];
  const s = tail.trim();
  SPACE_KEY_RE.lastIndex = 0;
  const marks: { key: string; valStart: number; start: number }[] = [];
  for (let m = SPACE_KEY_RE.exec(s); m; m = SPACE_KEY_RE.exec(s)) {
    marks.push({ key: m[1].toLowerCase(), start: m.index, valStart: m.index + m[0].length });
  }
  if (marks.length === 0) {
    if (s) positional.push(parseVal(s));
    return { named, positional };
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : s.length;
    named[marks[i]!.key] = parseVal(s.slice(marks[i]!.valStart, end).trim().replace(/,\s*$/, ""));
  }
  return { named, positional };
}

function looksLikePlaceholder(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return true;
  if (/^[.…\-_\s]*$/.test(t)) return true;
  return ["content", "text", "value", "your memory here", "<content>", "the thing", "something"].includes(t);
}

// Turn parsed args into a validated, executable call for ONE tool, or null if it doesn't look real.
// Lengths mirror the tools' zod so this and the handler agree; executeTool's zod is still the backstop.
function buildTypedCall(name: string, named: Record<string, ArgVal>, positional: ArgVal[]): RecoveredTypedCall | null {
  if (name === "remember") {
    const raw = typeof named.content === "string" ? named.content : typeof positional[0] === "string" ? positional[0] : undefined;
    if (typeof raw !== "string") return null;
    const content = raw.trim();
    if (content.length < 3 || content.length > 2000 || looksLikePlaceholder(content)) return null;
    const args: Record<string, unknown> = { content };
    if (typeof named.key === "string" && named.key.trim()) args.key = named.key.trim();
    if (typeof named.category === "string" && named.category.trim()) args.category = named.category.trim();
    return { name, args };
  }
  if (name === "current_moment") {
    const raw = typeof named.text === "string" ? named.text : typeof positional[0] === "string" ? positional[0] : undefined;
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (text.length < 1 || text.length > 500 || looksLikePlaceholder(text)) return null;
    return { name, args: { text } };
  }
  if (name === "forget") {
    let id: ArgVal | undefined = named.id ?? positional[0];
    if (typeof id === "string") id = Number(id);
    if (typeof id !== "number" || !Number.isInteger(id)) return null;
    return { name, args: { id } };
  }
  if (name === "message_user") {
    const raw = typeof named.message === "string" ? named.message : typeof positional[0] === "string" ? positional[0] : undefined;
    if (typeof raw !== "string") return null;
    const message = raw.trim();
    if (message.length < 1 || message.length > 2000 || looksLikePlaceholder(message)) return null;
    return { name, args: { message } };
  }
  return null;
}

// Recover text-form tool calls for the given `names`, in document order, deduped on (name + args). Three
// conservative, tool-shaped grammars: typed call `remember(content="x")` (NO space before "("), bracket-
// colon `[remember: x]`, and (underscored names only) space-kwargs `current_moment text: …`. The bare line
// form ("Remember: buy milk") is intentionally NOT matched — indistinguishable from prose.
export function recoverTypedToolCalls(text: string, names: readonly string[]): RecoveredTypedCall[] {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!alt) return [];
  const hits: { idx: number; call: RecoveredTypedCall }[] = [];

  const callRe = new RegExp(`\\b(${alt})\\(([^)]*)\\)`, "gi");
  for (let m = callRe.exec(text); m; m = callRe.exec(text)) {
    const name = m[1].toLowerCase();
    if (!want.has(name)) continue;
    const { named, positional } = parseArgs(m[2]);
    const call = buildTypedCall(name, named, positional);
    if (call) hits.push({ idx: m.index, call });
  }

  const brRe = new RegExp(`\\[\\s*(${alt})\\s*:\\s*([^\\]]*)\\]`, "gi");
  for (let m = brRe.exec(text); m; m = brRe.exec(text)) {
    const name = m[1].toLowerCase();
    if (!want.has(name)) continue;
    const call = buildTypedCall(name, {}, [parseVal(m[2])]);
    if (call) hits.push({ idx: m.index, call });
  }

  const spaceRe = new RegExp(`(?:^|\\n)[ \\t]*[\`'"*]*(${alt})[\`'"*]*[ \\t]+(?!\\()([^\\n]+)`, "gi");
  for (let m = spaceRe.exec(text); m; m = spaceRe.exec(text)) {
    const name = m[1].toLowerCase();
    if (!want.has(name) || !name.includes("_")) continue; // underscored tools only (prose-safe)
    const { named, positional } = parseSpaceArgs(m[2]);
    const call = buildTypedCall(name, named, positional);
    if (call) hits.push({ idx: m.index, call });
  }

  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.idx - b.idx)
    .map((h) => h.call)
    .filter((c) => {
      const k = `${c.name}:${JSON.stringify(c.args)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
