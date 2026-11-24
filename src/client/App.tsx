import { useEffect, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { createThread, loadMe, loadThread, signIn, signOut, streamRun, type Me } from "./chat/api";
import { Thread } from "./chat/Thread";
import { Inbox } from "./inbox/Inbox";

function Chat({ tenantId, medicines }: { tenantId: string; medicines: string[] }) {
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
      <Thread tenantId={tenantId} medicines={medicines} />
    </AssistantRuntimeProvider>
  );
}

// Lesson 11. The page asks the server who is signed in; it never decides that itself.
export function App() {
  const [state, setState] = useState<Awaited<ReturnType<typeof loadMe>> | { failed: string } | null>(null);
  useEffect(() => {
    loadMe()
      .then(setState)
      .catch((error: Error) => setState({ failed: error.message }));
  }, []);

  if (!state) return <div className="app" aria-busy="true" />;
  if ("me" in state) return <SignedIn me={state.me} />;
  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-title">HCP Medical Information Agent</span>
      </header>
      <main className="signin">
        {"signedOut" in state ? (
          <>
            <h1>Sign in to ask your company&apos;s desk</h1>
            <p>You sign in on your company&apos;s sign-in page. Your company and country come from your account there.</p>
            <button type="button" className="button button-primary" onClick={signIn}>
              Sign in
            </button>
          </>
        ) : (
          <>
            <h1>{"refused" in state ? "Your account cannot use this desk yet" : "The desk is not reachable"}</h1>
            <p>{"refused" in state ? state.refused : state.failed}</p>
            {"refused" in state && (
              <button type="button" className="button" onClick={() => void signOut()}>
                Sign out
              </button>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// Two pages, chosen by the address: the chat at /, the review inbox at /inbox (lesson 13).
function SignedIn({ me }: { me: Me }) {
  const [chat, setChat] = useState(0);
  const onInbox = window.location.pathname === "/inbox";
  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-title">HCP Medical Information Agent</span>
        <span className="topbar-desk" aria-label="Your desk">
          <span className="chip">{me.company.name}</span>
          <span className="chip">{me.company.medicines.join(" · ")}</span>
          <span className="chip">{me.user.country}</span>
        </span>
        <span className="topbar-user">{me.user.name}</span>
        <a className="button" href={onInbox ? "/" : "/inbox"} aria-current={onInbox ? "page" : undefined}>
          {onInbox ? "Chat" : "Inbox"}
        </a>
        {!onInbox && (
          <button type="button" className="button" onClick={() => setChat((count) => count + 1)}>
            New chat
          </button>
        )}
        <button type="button" className="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {onInbox ? <Inbox /> : <Chat key={chat} tenantId={me.user.tenantId} medicines={me.company.medicines} />}
    </div>
  );
}
