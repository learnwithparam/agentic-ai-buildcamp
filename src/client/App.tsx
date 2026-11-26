import { useEffect, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { createThread, loadMe, loadThread, signIn, signOut, streamRun, type Me } from "./chat/api";
import { Thread } from "./chat/Thread";
import { RunsContext } from "./chat/RunSteps";
import type { AnswerRun } from "../shared/run";
import { Editor } from "./content/Editor";
import { Events } from "./content/Events";
import { Sweep } from "./content/Sweep";
import { Handoffs } from "./content/Handoffs";
import { Outreach } from "./content/Outreach";
import { Inbox } from "./inbox/Inbox";
import { Insights } from "./insights/Insights";
import { ANALYST_ROLE, REVIEWER_ROLES, STAFF_ROLES } from "../server/users";

function Chat({ tenantId, medicines }: { tenantId: string; medicines: string[] }) {
  // Step 2B: how each reply was made, from the saved thread and from each values event.
  const [runs, setRuns] = useState<Record<string, AnswerRun>>({});
  const runtime = useLangGraphRuntime({
    create: () => createThread(),
    load: async (threadId) => {
      const thread = await loadThread(threadId);
      setRuns(thread.runs ?? {});
      return thread;
    },
    stream: async function* (messages, config) {
      const { externalId } = await config.initialize();
      if (!externalId) throw new Error("No thread id");
      for await (const event of streamRun(externalId, messages, config)) {
        const values = event.event === "values" ? (event.data as { runs?: Record<string, AnswerRun> }) : undefined;
        if (values?.runs) setRuns(values.runs);
        yield event;
      }
    }
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunsContext.Provider value={runs}>
        <Thread tenantId={tenantId} medicines={medicines} />
      </RunsContext.Provider>
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

// The pages, chosen by the address: the chat at /, the review inbox at /inbox (lesson 13), and
// for a company's staff the email editor and the rep board (lesson 14), hand-offs (lesson 15), the event inbox (lesson 16), and the nightly sweep (lesson 17). The server refuses a
// page's data to anyone not allowed it; the links here only spare a doctor a page they cannot use.
// Lesson 16: the event inbox is for anyone who decides what events raise, the safety reviewer included.
const PAGES: Array<{ path: string; label: string; roles?: readonly string[] }> = [
  { path: "/", label: "Chat" },
  { path: "/editor", label: "Email editor", roles: STAFF_ROLES },
  { path: "/outreach", label: "Rep board", roles: STAFF_ROLES },
  { path: "/handoffs", label: "Hand-offs", roles: STAFF_ROLES },
  { path: "/events", label: "Events", roles: REVIEWER_ROLES },
  { path: "/sweep", label: "Sweep", roles: REVIEWER_ROLES },
  // Lesson 22: the insights agent, for each company's analysts.
  { path: "/insights", label: "Insights", roles: [ANALYST_ROLE] },
  { path: "/inbox", label: "Inbox" }
];

// A link is hidden from a user without the role, but the address still works when typed. The server
// refuses the page's data either way; this says why, instead of a page that never answers.
function NotForYou({ label }: { label: string }) {
  return (
    <main className="inbox">
      <p className="refusal">The {label} page is not part of your role, so it is closed to you.</p>
    </main>
  );
}

function SignedIn({ me }: { me: Me }) {
  const [chat, setChat] = useState(0);
  const path = window.location.pathname;
  const may = (page: (typeof PAGES)[number]) => !page.roles || me.user.roles.some((role) => page.roles!.includes(role));
  const onChat = !PAGES.some((page) => page.path !== "/" && page.path === path);
  const page = PAGES.find((entry) => entry.path !== "/" && entry.path === path);
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
        <nav className="topbar-nav" aria-label="Pages">
          {PAGES.filter(may).map((page) => (
            <a key={page.path} className="button" href={page.path} aria-current={(page.path === "/" ? onChat : page.path === path) ? "page" : undefined}>
              {page.label}
            </a>
          ))}
        </nav>
        {onChat && (
          <button type="button" className="button" onClick={() => setChat((count) => count + 1)}>
            New chat
          </button>
        )}
        <button type="button" className="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {page && !may(page) ? <NotForYou label={page.label} /> : path === "/inbox" ? <Inbox /> : path === "/editor" ? <Editor /> : path === "/outreach" ? <Outreach /> : path === "/handoffs" ? <Handoffs /> : path === "/events" ? <Events /> : path === "/sweep" ? <Sweep roles={me.user.roles} /> : path === "/insights" ? <Insights company={me.company.name} /> : <Chat key={chat} tenantId={me.user.tenantId} medicines={me.company.medicines} />}
    </div>
  );
}
