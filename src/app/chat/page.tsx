"use client";

import { useEffect, useRef, useState } from "react";

// Minimal chat surface. Sends a message (POST /api/chat/message → fire-and-forget tick), and polls
// /api/outbound/pending for the agent's delivered replies (+ any proactive reach-outs), acking them so
// they aren't re-shown. Deliberately bare — this is a way to talk to the brain, not a product.

interface Turn {
  role: string;
  content: string;
  key: string;
}

export default function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const seen = useRef<Set<number>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  // Load history once.
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/chat/history?limit=100");
      if (!res.ok) return;
      const { turns: t } = (await res.json()) as { turns: { role: string; content: string; createdAt: string }[] };
      setTurns(t.map((x, i) => ({ role: x.role, content: x.content, key: `h${i}` })));
    })();
  }, []);

  // Poll for delivered outbound messages.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/outbound/pending");
        if (res.ok) {
          const { messages } = (await res.json()) as { messages: { id: number; content: string }[] };
          const fresh = messages.filter((m) => !seen.current.has(m.id));
          if (fresh.length) {
            fresh.forEach((m) => seen.current.add(m.id));
            setTurns((prev) => [...prev, ...fresh.map((m) => ({ role: "agent", content: m.content, key: `o${m.id}` }))]);
            void fetch("/api/outbound/ack", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: fresh.map((m) => m.id) }),
            });
          }
        }
      } catch {
        /* transient — keep polling */
      }
      if (!stop) setTimeout(tick, 1500);
    };
    const h = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(h);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setInput("");
    setTurns((prev) => [...prev, { role: "user", content, key: `u${Date.now()}` }]);
    try {
      await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "1.5rem", display: "flex", flexDirection: "column", height: "100vh", boxSizing: "border-box" }}>
      <h1 style={{ fontSize: "1rem", color: "#9aa0a6", margin: "0 0 1rem" }}>homunculus · chat</h1>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {turns.map((t) => (
          <div
            key={t.key}
            style={{
              alignSelf: t.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              background: t.role === "user" ? "#1d3b53" : "#1a1d23",
              border: "1px solid #2a2e36",
              borderRadius: 10,
              padding: "0.6rem 0.8rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "#6b7177", marginBottom: 4 }}>{t.role}</div>
            {t.content}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Say something…"
          style={{
            flex: 1,
            background: "#1a1d23",
            border: "1px solid #2a2e36",
            borderRadius: 8,
            color: "#e6e6e6",
            padding: "0.6rem 0.8rem",
            fontFamily: "inherit",
          }}
        />
        <button
          onClick={() => void send()}
          disabled={sending}
          style={{ background: "#2563eb", color: "white", border: "none", borderRadius: 8, padding: "0 1rem", cursor: "pointer" }}
        >
          send
        </button>
      </div>
    </main>
  );
}
