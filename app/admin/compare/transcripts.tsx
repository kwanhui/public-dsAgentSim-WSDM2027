// Channel transcripts of the compare view: one row per stakeholder channel.

import { Disclosure } from "@/components/ui/disclosure";
import { plainChatText } from "@/lib/admin/chat-text";
import { plural } from "@/lib/admin/format";
import type { SideData } from "./side-data";

// One row per stakeholder channel holding both runs. A single toggle opens
// both columns, so the two transcripts stay level with each other.
export function ChannelComparison({ left, right }: { left: SideData | null; right: SideData | null }) {
  const personaIds = [
    ...new Set([
      ...(left?.channels ?? []).map((c) => c.channel.personaId),
      ...(right?.channels ?? []).map((c) => c.channel.personaId),
    ]),
  ];
  if (personaIds.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">No channels to show.</p>;
  }
  return (
    <div className="mt-3 space-y-2">
      {personaIds.map((personaId) => {
        const leftChannel = left?.channels.find((c) => c.channel.personaId === personaId) ?? null;
        const rightChannel = right?.channels.find((c) => c.channel.personaId === personaId) ?? null;
        const label = leftChannel?.label ?? rightChannel?.label ?? personaId;
        return (
          <Disclosure
            key={personaId}
            title={
              <span className="text-sm">
                {label}{" "}
                <span className="font-normal text-muted-foreground">
                  (left {channelSummary(left, leftChannel)}, right{" "}
                  {channelSummary(right, rightChannel)})
                </span>
              </span>
            }
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <TranscriptColumn side="Left" data={left} channel={leftChannel} />
              <TranscriptColumn side="Right" data={right} channel={rightChannel} />
            </div>
          </Disclosure>
        );
      })}
    </div>
  );
}

type ChannelEntry = SideData["channels"][number];

function channelSummary(data: SideData | null, channel: ChannelEntry | null): string {
  if (!data) return "no run selected";
  if (!channel) return "no such channel";
  return `${plural(channel.messages.length, "message")}${channel.channel.unlockedAt ? "" : ", locked"}`;
}

function TranscriptColumn({
  side,
  data,
  channel,
}: {
  side: string;
  data: SideData | null;
  channel: ChannelEntry | null;
}) {
  const who = data?.isAgent ? "Analyst agent" : "Learner";
  return (
    <div className="min-w-0 rounded-md border p-3">
      <p className="text-xs font-medium">
        {side}
        {data ? <span className="text-muted-foreground"> · {who} side</span> : null}
      </p>
      {!data || !channel ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {data ? "This run has no such channel." : `No ${side.toLowerCase()} engagement selected.`}
        </p>
      ) : channel.messages.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No messages.</p>
      ) : (
        <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto text-sm">
          {channel.messages.map((m) => (
            <li key={m.id}>
              <span className="font-medium text-foreground">
                {m.sender === "learner" ? who : channel.personaName}:
              </span>{" "}
              <span className="whitespace-pre-wrap">
                {m.sender === "learner" && data.isAgent ? plainChatText(m.content) : m.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
