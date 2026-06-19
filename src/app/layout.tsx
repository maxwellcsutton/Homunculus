import type { ReactNode } from "react";

export const metadata = {
  title: "homunculus",
  description: "An autonomous agent that plays turn-based, idle, and text-based games and forms its own memories, opinions, and self-image.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          background: "#0f1115",
          color: "#e6e6e6",
        }}
      >
        {children}
      </body>
    </html>
  );
}
