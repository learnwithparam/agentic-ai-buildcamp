import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { useLangGraphInterruptState, useLangGraphSendCommand } from "@assistant-ui/react-langgraph";
import { SUGGESTIONS } from "./suggestions";
import { DeskRulesCard, MarkdownText, OtherToolCard, SearchLabelsCard, Thinking } from "./parts";

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
            by_name: { search_labels: SearchLabelsCard, get_desk_rules: DeskRulesCard },
            Fallback: OtherToolCard
          }
        }}
      />
    </MessagePrimitive.Root>
  );
}

// The draft is shown as the doctor would read it, without markdown marks.
const plain = (text: string) => text.replace(/\*\*|__/g, "");

type ApprovalRequest = { kind?: string; draft?: string; question?: string };

// Shown when the graph pauses at the review node. The reviewer's choice resumes it.
function ApprovalCard() {
  const pause = useLangGraphInterruptState();
  const sendCommand = useLangGraphSendCommand();
  const request = pause?.value as ApprovalRequest | undefined;
  if (request?.kind !== "approval") return null;
  return (
    <div className="card approval">
      <div className="card-head">Waiting for a medical reviewer</div>
      <div className="card-body">
        <div className="approval-draft">{plain(request.draft ?? "")}</div>
        <div className="approval-actions">
          <button type="button" className="button button-primary" onClick={() => sendCommand({ resume: "approve" })}>
            Approve and send
          </button>
          <button type="button" className="button" onClick={() => sendCommand({ resume: "reject" })}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export function Thread({ tenantId }: { tenantId: string }) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="viewport">
        <div className="column">
          <AuiIf condition={(state) => state.thread.isEmpty}>
            <div className="empty">
              <h1>Ask about CardioNex</h1>
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
          <ApprovalCard />
        </div>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input className="composer-input" placeholder="Ask a medical information question" autoFocus />
        <ComposerPrimitive.Send className="button button-primary">Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
