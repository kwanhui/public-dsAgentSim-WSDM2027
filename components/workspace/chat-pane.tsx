"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clearStashedMessage,
  peekStashedMessage,
  stashInFlightMessage,
} from "./chat-stash";
import type { BundlePersona, ChatMessage } from "./types";
import { SimulatedLabel } from "./simulated-notice";
import { formatLearnerTime } from "./learner-time";
import { messagesLeftLine, remainingFromResponse } from "./message-allowance";
import { localBudgetRefusal } from "@/lib/llm/budget-format";
import { MOCK_LINE, withoutMockNote } from "./learner-copy";

export function ChatPane({
  channelId,
  persona,
  readOnly,
  messagesRemaining,
  maxMessages,
  onMessagesRemaining,
  onStateChange,
  onOpenFiles,
  onFilesReleased,
  onRead,
  sandbox = false,
  mock = false,
}: {
  channelId: string;
  persona: BundlePersona | undefined;
  readOnly: boolean;
  /** Messages the learner may still send in this engagement. */
  messagesRemaining: number;
  maxMessages: number;
  /** Reports the count a chat response carries, after each send. */
  onMessagesRemaining: (remaining: number) => void;
  onStateChange: () => Promise<void>;
  onOpenFiles: () => void;
  onFilesReleased: () => void;
  /** How many persona messages this pane is showing, so the workspace can
   * count replies that arrived while the channel was open as read. */
  onRead: (channelId: string, personaMessages: number) => void;
  /** A demo sandbox seat: the budget message names no instructor. */
  sandbox?: boolean;
  /** The offline mock: one plain line in the header replaces the note at
   * the end of every mock reply. */
  mock?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  // A stash left behind means the tab closed while a turn was in flight; the
  // server persists the question only together with the reply, so that
  // message never reached the transcript. Start the box with it. The pane is
  // keyed by channel (workspace-client.tsx), so mount is per channel and the
  // box would otherwise start empty.
  const [draft, setDraft] = useState(() => peekStashedMessage(channelId) ?? "");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  // A refusal the server explained (daily usage limit, message cap). Retrying
  // will not help, so it replaces the retry prompt.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [restoredFromStash, setRestoredFromStash] = useState(
    () => peekStashedMessage(channelId) !== null,
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const capReached = messagesRemaining <= 0;

  // The restored message now lives in the box, so the stash's job is done;
  // without this, a restored message the learner deletes would resurface on
  // every future visit to the channel.
  useEffect(() => {
    clearStashedMessage(channelId);
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/chat?channelId=${encodeURIComponent(channelId)}`, {
        cache: "no-store",
      });
      if (!cancelled && res.ok) {
        const data = (await res.json()) as { messages: ChatMessage[] };
        setMessages(data.messages);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    if (!messages) return;
    onRead(channelId, messages.filter((m) => m.sender !== "learner").length);
  }, [channelId, messages, onRead]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || readOnly || capReached) return;
    setSending(true);
    setSendFailed(false);
    setRefusal(null);
    setRestoredFromStash(false);
    // Kept until the reply confirms both sides are persisted, so the message
    // survives a reload or tab close mid-turn (chat-stash.ts). A failed send
    // leaves the stash in place: the draft restore below covers this session,
    // the stash covers the next one.
    stashInFlightMessage(channelId, text);
    // Shown while the turn is in flight only. The server writes the learner's
    // message to the transcript together with the persona's reply, so a
    // failed turn leaves nothing behind and resending cannot double it up.
    const optimistic: ChatMessage = {
      id: -Date.now(),
      sender: "learner",
      content: text,
      timestampIso: new Date().toISOString(),
    };
    setMessages((m) => [...(m ?? []), optimistic]);
    setDraft("");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, message: text }),
    }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as {
        learnerMessage: ChatMessage;
        message: ChatMessage;
        releasedFiles: string[];
        messagesRemaining?: number;
      };
      clearStashedMessage(channelId);
      const remaining = remainingFromResponse(data);
      if (remaining !== null) onMessagesRemaining(remaining);
      setMessages((m) => [
        ...(m ?? []).filter((msg) => msg.id !== optimistic.id),
        data.learnerMessage,
        data.message,
      ]);
      if (data.releasedFiles.length > 0) {
        onFilesReleased();
        await onStateChange();
      }
    } else {
      const body = res
        ? ((await res.json().catch(() => null)) as {
            error?: string;
            message?: string;
            resetsAtIso?: string;
            messagesRemaining?: number;
          } | null)
        : null;
      const remaining = remainingFromResponse(body);
      if (remaining !== null) onMessagesRemaining(remaining);
      if (res && (res.status === 429 || res.status === 409) && body?.message) {
        // A budget refusal names the reset in the learner's own time.
        setRefusal(localBudgetRefusal("chat", body, undefined, sandbox ? "sandbox" : "course") ?? body.message);
      } else {
        setSendFailed(true);
      }
      setMessages((m) => (m ?? []).filter((msg) => msg.id !== optimistic.id));
      setDraft(text);
    }
    setSending(false);
  }

  return (
    <div className="flex h-[70vh] max-w-3xl flex-col rounded-lg border md:h-[calc(100vh-9rem)]">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          {persona?.channelName ?? "Channel"} <SimulatedLabel />
        </h2>
        <p className="text-xs text-muted-foreground">{persona?.title}</p>
        {mock ? <p className="mt-1 text-xs text-foreground">{MOCK_LINE}</p> : null}
      </div>

      <div
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
        aria-label={`Conversation with ${persona?.name ?? "stakeholder"}`}
      >
        {messages === null ? (
          <p className="text-sm text-muted-foreground">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              data-testid={m.sender === "learner" ? "learner-message" : "persona-message"}
              className={cn("flex gap-2", m.sender === "learner" ? "justify-end" : "justify-start")}
            >
              {m.sender !== "learner" ? (
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground"
                >
                  {initials(persona?.name)}
                </span>
              ) : null}
              <div
                className={cn(
                  "max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                  m.sender === "learner"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted",
                )}
              >
                {m.sender !== "learner" ? (
                  <p className="mb-0.5 text-xs font-medium text-foreground/70">
                    {persona?.name}
                  </p>
                ) : null}
                <MessageBody
                  content={mock && m.sender !== "learner" ? withoutMockNote(m.content) : m.content}
                  onOpenFiles={onOpenFiles}
                />
                <p
                  className={cn(
                    "mt-1 text-right text-[10px]",
                    m.sender === "learner"
                      ? "text-primary-foreground"
                      : "text-foreground/60",
                  )}
                >
                  {formatLearnerTime(m.timestampIso)}
                </p>
                {m.sender !== "learner" && m.platformNote ? (
                  <p data-testid="platform-note" className="mt-1 border-t border-foreground/10 pt-1 text-xs text-muted-foreground">
                    Platform: {m.platformNote}
                  </p>
                ) : null}
              </div>
            </div>
          ))
        )}
        {sending ? (
          <p className="text-xs text-muted-foreground">Waiting for reply</p>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {restoredFromStash && !sendFailed ? (
        <div role="status" className="border-t px-4 py-2 text-xs text-muted-foreground">
          Your last message was not delivered. It is back in the box.
        </div>
      ) : null}

      {/* At the cap, the line under the composer already says so. */}
      {refusal && !capReached ? (
        // A pause or a cap is information, not an alarm, so it is not red.
        <div role="alert" className="border-t bg-muted/40 px-4 py-2 text-xs text-foreground">
          {refusal} Your message is back in the box.
        </div>
      ) : null}

      {sendFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-flag">
          <span>
            {persona?.name ?? "Your stakeholder"} could not reply just now, so nothing was saved
            to the conversation. Your message is back in the box.
          </span>
          <Button size="sm" variant="danger" loading={sending} onClick={() => void send()}>
            Retry
          </Button>
        </div>
      ) : null}

      {readOnly ? (
        // A closed engagement keeps the transcript readable and drops the
        // composer altogether.
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          The engagement is closed. This conversation stays readable.
        </p>
      ) : (
        <div className="border-t">
          <form
            className="flex items-end gap-2 px-4 pb-1 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              maxLength={4000}
              aria-label={`Message to ${persona?.name ?? "stakeholder"}`}
              disabled={sending || capReached}
              placeholder={`Message ${persona?.name ?? ""}…`}
              className="min-h-[2.5rem] flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            <div className="flex flex-col items-end gap-1">
              <Button type="submit" variant="primary" size="md" loading={sending} disabled={capReached || !draft.trim()}>
                Send
              </Button>
              <span className="hidden text-[10px] text-muted-foreground sm:block">
                Enter to send · Shift+Enter for a new line
              </span>
            </div>
          </form>
          <p role="status" className="px-4 pb-2 text-xs text-muted-foreground">
            {messagesLeftLine(messagesRemaining, maxMessages)}
          </p>
        </div>
      )}
    </div>
  );
}

// The orchestrator marks a dataset release with a trailing "[Attached: ...]"
// line (lib/agents/orchestrator.ts). Render that line as a way into the Data
// files pane rather than as text naming a place the learner has to find.
// Messages stored before the copy pass separate the file name with an em
// dash, newer ones with a comma; both forms match.
const ATTACHMENT_LINE = /\n*\[Attached: (.+?)(?:,| \u2014) available under Data files\]\s*$/;

function MessageBody({ content, onOpenFiles }: { content: string; onOpenFiles: () => void }) {
  const match = content.match(ATTACHMENT_LINE);
  if (!match) return <>{content}</>;
  return (
    <>
      {content.slice(0, match.index)}
      <button
        type="button"
        onClick={onOpenFiles}
        className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-foreground/20 bg-background/50 px-2 py-1.5 text-left text-xs font-medium underline-offset-4 hover:underline"
      >
        <span aria-hidden="true">↓</span>
        <span className="min-w-0 flex-1 break-words">{match[1]}</span>
        <span className="shrink-0 opacity-80">Open in Data files</span>
      </button>
    </>
  );
}

function initials(name: string | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}
