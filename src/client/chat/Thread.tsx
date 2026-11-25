import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { useLangGraphInterruptState } from "@assistant-ui/react-langgraph";
import { formatDue } from "../inbox/format";
import { SUGGESTIONS } from "./suggestions";
import { DeskRulesCard, LookupCard, MarkdownText, OtherToolCard, SearchLabelsCard, Thinking } from "./parts";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message-user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message-assistant">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          Reasoning: Thinking,
          tools: {
            by_name: {
              search_labels: SearchLabelsCard,
              get_desk_rules: DeskRulesCard,
              read_section: LookupCard,
              label_versions: LookupCard,
              approval_status: LookupCard,
              check_interaction: LookupCard,
              trial_results: LookupCard
            },
            Fallback: OtherToolCard
          }
        }}
      />
    </MessagePrimitive.Root>
  );
}

type ApprovalRequest = { kind?: string; draft?: string; dueAt?: string };

// Lesson 13. Shown while the graph is paused at the review node. The doctor cannot approve their
// own draft: a medical reviewer decides it in the inbox, and the thread continues from there.
function WaitingCard() {
  const pause = useLangGraphInterruptState();
  const request = pause?.value as ApprovalRequest | undefined;
  if (request?.kind !== "approval") return null;
  return (
    <div className="card approval">
      <div className="card-head">
        <span>Waiting for a medical reviewer</span>
        {request.dueAt && <span className="status status-wait">Due {formatDue(request.dueAt)}</span>}
      </div>
      <div className="card-body">
        <p className="approval-note">
          The draft above is not sent until a reviewer approves it. <a href="/inbox">Your inbox</a> shows the decision.
        </p>
      </div>
    </div>
  );
}

export function Thread({ tenantId, medicines }: { tenantId: string; medicines: string[] }) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="viewport">
        <div className="column">
          <AuiIf condition={(state) => state.thread.isEmpty}>
            <div className="empty">
              <h1>Ask about {medicines.join(" or ")}</h1>
              <p>Answers come from the approved labels, with a citation for every fact.</p>
              <div className="suggestions">
                {(SUGGESTIONS[tenantId] ?? []).map((prompt) => (
                  <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send asChild>
                    <button type="button" className="suggestion">
                      {prompt}
                    </button>
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <WaitingCard />
        </div>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input className="composer-input" placeholder="Ask a medical information question" autoFocus />
        <ComposerPrimitive.Send className="button button-primary">Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
