import { useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { createThread, loadThread, streamRun } from "./chat/api";
import { Thread } from "./chat/Thread";

function Chat() {
  const runtime = useLangGraphRuntime({
    create: createThread,
    load: loadThread,
    stream: async function* (messages, config) {
      const { externalId } = await config.initialize();
      if (!externalId) throw new Error("No thread id");
      yield* streamRun(externalId, messages, config);
    }
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

export function App() {
  const [chat, setChat] = useState(0);
  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-title">HCP Medical Information Agent</span>
        <span className="topbar-desk">
          <span className="chip">pharma_a</span>
          <span className="chip">CardioNex</span>
          <span className="chip">US · DE · JP</span>
        </span>
        <button type="button" className="button" onClick={() => setChat((count) => count + 1)}>
          New chat
        </button>
      </header>
      <Chat key={chat} />
    </div>
  );
}
