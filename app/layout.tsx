import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgenticPracticum: Simulated Data-Science Engagements",
  description:
    "AgenticPracticum: a course tool for practising a data-science engagement, from problem formulation to handover, with simulated stakeholders played by a language model.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
