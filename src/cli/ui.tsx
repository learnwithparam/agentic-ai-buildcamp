import { Box, Text, useAnimation, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { ApprovalRequest, StreamEvent } from "../shared/messages";
import type { Decision, Inbox, Me, ReviewItem } from "./api";
import { CliError } from "./config";
import { runTurn, START, type TurnView } from "./turn";

// Lesson 19. The terminal screens, written with Ink (React for the terminal). They show what the
// chat page shows: the answer with its citations, what the agent is doing, and who it waits for.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner({ label }: { label: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return (
    <Text color="yellow">
      {FRAMES[frame % FRAMES.length]} {label}
    </Text>
  );
}

// A citation such as [cardionex-label-2026, 2.1] in colour, so the doctor sees where each fact
// comes from at a glance, and **bold** from the answer's Markdown in bold.
export function Answer({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]\n]+, [^\]\n]+\]|\*\*[^*\n]+\*\*)/);
  return (
    <Text>
      {parts.map((part, index) =>
        index % 2 === 0 ? (
          part
        ) : part.startsWith("**") ? (
          <Text key={index} bold>
            {part.slice(2, -2)}
          </Text>
        ) : (
          <Text key={index} color="cyan">
            {part}
          </Text>
        )
      )}
    </Text>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function WaitingNote({ waiting }: { waiting: ApprovalRequest }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        A medical reviewer checks this answer before you get it.
      </Text>
      <Text>
        Inbox item <Text bold>{waiting.itemId}</Text>, due by {when(waiting.dueAt)}.
      </Text>
    </Box>
  );
}

export function TurnScreen({ view }: { view: TurnView }) {
  return (
    <Box flexDirection="column" gap={1}>
      {view.activity && !view.done ? <Spinner label={view.activity} /> : null}
      {view.text && !view.waiting ? <Answer text={view.text} /> : null}
      {view.waiting ? <WaitingNote waiting={view.waiting} /> : null}
    </Box>
  );
}

export function ThreadHint({ threadId }: { threadId: string }) {
  return <Text dimColor>Follow up with: medinfo ask --thread {threadId} "..."</Text>;
}

// medinfo ask: reads the stream and redraws as it goes. The thread id is printed last, so the
// next question can carry on the same conversation.
export function AskScreen({ events, threadId, onEnd }: { events: AsyncIterable<StreamEvent>; threadId: string; onEnd: (error?: Error) => void }) {
  const { exit } = useApp();
  const [view, setView] = useState<TurnView>(START);
  useEffect(() => {
    runTurn(events, setView).then(
      () => (onEnd(), exit()),
      (error: Error) => (onEnd(error), exit())
    );
  }, []);
  return (
    <Box flexDirection="column" gap={1}>
      <TurnScreen view={view} />
      {view.done ? <ThreadHint threadId={threadId} /> : null}
    </Box>
  );
}

export function WhoAmI({ me }: { me: Me }) {
  return (
    <Box flexDirection="column">
      <Text>
        Signed in as <Text bold>{me.user.name}</Text> ({me.user.email})
      </Text>
      <Text>
        {me.company.name}, {me.user.country}
        {me.user.roles.length ? `, ${me.user.roles.join(", ")}` : ""}
      </Text>
      <Text dimColor>Medicines: {me.company.medicines.join(", ")}</Text>
    </Box>
  );
}

const KIND_WORDS: Record<ReviewItem["kind"], string> = {
  draft: "Draft answer",
  adverse_event: "Adverse event",
  email: "Email",
  outreach: "Outreach step"
};

// Which decisions each kind takes, with the key that makes it. The server checks them again.
export const KEYS: Record<ReviewItem["kind"], Array<{ key: string; decision: Decision; label: string }>> = {
  draft: [
    { key: "a", decision: "approved", label: "approve" },
    { key: "r", decision: "rejected", label: "reject" }
  ],
  email: [
    { key: "a", decision: "approved", label: "approve" },
    { key: "r", decision: "rejected", label: "reject" }
  ],
  outreach: [
    { key: "a", decision: "approved", label: "approve" },
    { key: "r", decision: "rejected", label: "reject" }
  ],
  adverse_event: [
    { key: "f", decision: "filed", label: "file" },
    { key: "d", decision: "dismissed", label: "dismiss" }
  ]
};

function ItemRow({ item, selected }: { item: ReviewItem; selected: boolean }) {
  const late = item.status === "waiting" && new Date(item.dueAt).getTime() < Date.now();
  return (
    <Text inverse={selected} color={item.status === "waiting" ? undefined : "gray"} wrap="truncate-end">
      {selected ? "›" : " "} {KIND_WORDS[item.kind].padEnd(14)} {item.status.padEnd(9)} <Text color={late ? "red" : undefined}>due {when(item.dueAt)}</Text>{" "}
      {item.question.replace(/\s+/g, " ")}
    </Text>
  );
}

export function InboxList({ inbox, selected = -1 }: { inbox: Inbox; selected?: number }) {
  if (!inbox.items.length) return <Text dimColor>Nothing in your inbox.</Text>;
  return (
    <Box flexDirection="column">
      {inbox.items.map((item, index) => (
        <ItemRow key={item.id} item={item} selected={index === selected} />
      ))}
    </Box>
  );
}

// medinfo inbox: up and down to choose, a key to decide, q to quit. Someone who is not a
// reviewer sees their own waiting questions and cannot decide anything.
export function InboxScreen({ inbox: first, decide }: { inbox: Inbox; decide: (itemId: string, decision: Decision) => Promise<ReviewItem> }) {
  const { exit } = useApp();
  const [inbox, setInbox] = useState(first);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const item = inbox.items[selected];
  const keys = item && inbox.reviewer && item.status === "waiting" ? KEYS[item.kind] : [];
  useInput((input, key) => {
    if (input === "q" || key.escape) return exit();
    if (key.upArrow) return setSelected((index) => Math.max(0, index - 1));
    if (key.downArrow) return setSelected((index) => Math.min(inbox.items.length - 1, index + 1));
    const choice = keys.find((entry) => entry.key === input);
    if (!item || !choice) return;
    decide(item.id, choice.decision).then(
      (decided) => {
        setInbox((current) => ({ ...current, items: current.items.map((entry) => (entry.id === decided.id ? decided : entry)) }));
        setNote({ text: `${KIND_WORDS[item.kind]} ${choice.decision}.`, error: false });
      },
      (error: Error) => setNote({ text: error instanceof CliError ? error.message : "The decision did not go through.", error: true })
    );
  });
  return (
    <Box flexDirection="column" gap={1}>
      <InboxList inbox={inbox} selected={selected} />
      {item ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{item.question}</Text>
          <Answer text={item.body} />
        </Box>
      ) : null}
      {note ? <Text color={note.error ? "red" : "green"}>{note.text}</Text> : null}
      <Text dimColor>
        ↑↓ choose{keys.map((entry) => `  ${entry.key} ${entry.label}`).join("")}  q quit
      </Text>
    </Box>
  );
}
