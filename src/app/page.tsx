import Link from "next/link";

// Bare landing. The point of this repo is the brain + API; the chat UI is a minimal way to talk to it.
export default function Home() {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "3rem 1.5rem", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.4rem" }}>homunculus</h1>
      <p style={{ color: "#9aa0a6" }}>
        An autonomous agent that plays turn-based, idle, and text-based games and forms its own memories, opinions, and self-image.
        This is the brain + a minimal chat UI. Wire a game via the GameAdapter contract; talk to it here.
      </p>
      <p>
        <Link href="/chat" style={{ color: "#7cc4ff" }}>
          → open chat
        </Link>
      </p>
      <p style={{ color: "#6b7177", fontSize: "0.85rem" }}>
        The continuous loop (heartbeat + rebake) runs in the background once the server boots. See CLAUDE.md
        and docs/ for architecture.
      </p>
    </main>
  );
}
