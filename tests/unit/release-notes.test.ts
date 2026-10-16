// The platform line under a data-owner reply whose file release was dropped
// (release_withheld): it reads the reason the event records and sits under
// the first reply of that persona after the scope message. The exhibit's
// Marcus says he is releasing the extract while the platform holds it back.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseNotesByMessage, releaseWithheldNote } from "@/lib/engagement/release-notes";

const withheld = (scopeMessageId: number, missing: string[], file = "churn_extract.csv") => ({
  type: "release_withheld",
  detailJson: { file, personaId: "data-owner", stage: "data-collection", missing, scopeMessageId },
});

describe("release-withheld platform line", () => {
  it("states the recorded reason", () => {
    expect(releaseWithheldNote(["column"])).toBe("No file was released: the request named no column of the data dictionary.");
    expect(releaseWithheldNote(["purpose"])).toBe("No file was released: the request stated no purpose.");
    expect(releaseWithheldNote(["column", "purpose"])).toBe(
      "No file was released: the request named no column of the data dictionary and stated no purpose.",
    );
    expect(releaseWithheldNote(["purpose"], ["b.csv"])).toBe("Not released: b.csv, because the request stated no purpose.");
  });

  it("sits under the data owner's reply to the scope message, in the same channel", () => {
    const messages = [
      { id: 10, channelId: "c1", sender: "learner", content: "Can I get the data?" },
      { id: 11, channelId: "c2", sender: "client", content: "Elsewhere." },
      { id: 12, channelId: "c1", sender: "data-owner", content: "Releasing churn_extract.csv now." },
      { id: 13, channelId: "c1", sender: "learner", content: "Thanks." },
      { id: 14, channelId: "c1", sender: "data-owner", content: "Sure." },
    ];
    const notes = releaseNotesByMessage([withheld(10, ["column"]), { type: "persona_turn", detailJson: {} }], messages);
    expect([...notes.keys()]).toEqual([12]);
    expect(notes.get(12)).toMatch(/^No file was released: /);
  });

  it("names the held file when another file in the same reply was released", () => {
    const messages = [
      { id: 1, channelId: "c1", sender: "learner" },
      { id: 2, channelId: "c1", sender: "data-owner", content: "Here you go.\n\n[Attached: a.csv, available under Data files]" },
    ];
    expect(releaseNotesByMessage([withheld(1, ["purpose"], "b.csv")], messages).get(2)).toBe(
      "Not released: b.csv, because the request stated no purpose.",
    );
  });

  it("finds the exhibit's held release in the showcase snapshot", () => {
    const s = JSON.parse(readFileSync("demo/showcase-snapshot.json", "utf8")) as {
      tables: { events: { type: string; detailJson: unknown }[]; messages: { id: number; channelId: string; sender: string; content: string }[] };
    };
    const notes = releaseNotesByMessage(s.tables.events, s.tables.messages);
    const held = [...notes.entries()].map(([id, note]) => ({ note, content: s.tables.messages.find((m) => m.id === id)!.content }));
    expect(held).toHaveLength(1);
    expect(held[0].content).toMatch(/^Releasing churn_extract\.csv now/);
    expect(held[0].note).toBe("No file was released: the request named no column of the data dictionary.");
  });
});
