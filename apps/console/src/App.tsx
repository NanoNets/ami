import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { useSse } from "./lib/useSse";
import { Toasts } from "./lib/toast";
import Home from "./pages/Home";
import TodoList from "./pages/TodoList";
import TaskDetail from "./pages/TaskDetail";
import MemoryGraph from "./pages/MemoryGraph";
import History from "./pages/History";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import Chat from "./pages/Chat";
import Agents from "./pages/Agents";

const SEARCH_TYPE_LABEL: Record<string, string> = {
  knowledge: "brain",
  chat: "chat",
  task: "task",
  signal: "signal",
};

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: results = [] } = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.search(q),
    enabled: q.trim().length >= 2,
    // Results morph in place while typing instead of blinking empty each keystroke.
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Cmd/Ctrl+K anywhere, or "/" outside a text field, jumps to search.
    const onKey = (e: KeyboardEvent) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = (r: { type: string; ref: string }) => {
    setOpen(false);
    setQ("");
    if (r.type === "knowledge") navigate(`/memory?note=${encodeURIComponent(r.ref)}`);
    else if (r.type === "chat") navigate(`/chat/${r.ref}`);
    else if (r.type === "task") navigate(`/tasks/${r.ref}`);
    else navigate("/history");
  };

  return (
    <div className="relative" ref={boxRef}>
      <input
        ref={inputRef}
        className="input h-8 w-48 focus:w-64 transition-[width] duration-200 text-sm"
        placeholder="Search…  ⌘K"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 top-9 w-96 max-h-96 overflow-y-auto bg-panel border border-edge2 shadow-lg z-20">
          {results.length === 0 ? (
            <p className="p-3 text-xs text-mut">No matches.</p>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.type}-${r.ref}-${i}`}
                className="block w-full text-left px-3 py-2 hover:bg-panel2 border-b border-edge last:border-0"
                onClick={() => go(r)}
              >
                <span className="flex items-center gap-2">
                  <span className="chip text-[10px] shrink-0">{SEARCH_TYPE_LABEL[r.type]}</span>
                  <span className="text-sm truncate">{r.title}</span>
                </span>
                {r.preview && <span className="block text-xs text-mut truncate mt-0.5">{r.preview}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

type PendingQuestion = {
  id: string;
  todoId: string | null;
  sessionId: string | null;
  kind: string;
  question: string;
};

function questionTarget(q: PendingQuestion): string {
  return q.todoId ? `/tasks/${q.todoId}` : q.sessionId ? `/chat/${q.sessionId}` : "/agents";
}

/** Header badge for agents blocked on the user. One item links straight to
 * it; several open a dropdown listing each question. */
function QuestionsBadge({ questions }: { questions: PendingQuestion[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (questions.length === 0) return null;
  if (questions.length === 1) {
    return (
      <NavLink to={questionTarget(questions[0])} className="flex items-center gap-1.5 text-xs text-acc">
        <span className="w-2 h-2 rounded-full bg-acc animate-pulse inline-block" />
        1 waiting on you
      </NavLink>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 text-xs text-acc cursor-pointer"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="w-2 h-2 rounded-full bg-acc animate-pulse inline-block" />
        {questions.length} waiting on you
      </button>
      {open && (
        <div className="absolute right-0 top-7 w-80 bg-panel border border-edge2 shadow-lg z-20">
          {questions.map((q) => (
            <button
              key={q.id}
              className="block w-full text-left px-3 py-2 hover:bg-panel2 border-b border-edge last:border-0"
              onClick={() => {
                setOpen(false);
                navigate(questionTarget(q));
              }}
            >
              <span className="block text-[10px] uppercase tracking-wide text-acc">
                {q.kind === "permission" ? "permission" : "question"}
              </span>
              <span className="block text-xs truncate mt-0.5">{q.question}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const NAV_LINKS = [
  { to: "/", label: "Home" },
  { to: "/todos", label: "To-do" },
  { to: "/chat", label: "Chat" },
  { to: "/agents", label: "Agents" },
  { to: "/history", label: "History" },
  { to: "/memory", label: "Memory" },
  { to: "/settings", label: "Settings" },
];

/** One accent bar slides between tabs instead of each tab painting its own
 * underline — navigation reads as movement, not as a repaint. */
function HeaderNav() {
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    // NavLink marks the active link with aria-current="page".
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    setBar(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [location.pathname]);

  return (
    <nav ref={navRef} className="relative flex gap-1 text-sm">
      {NAV_LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.to === "/"}
          className={({ isActive }) =>
            `px-3 py-1.5 transition-colors ${isActive ? "text-hi" : "text-mut hover:text-hi"}`
          }
        >
          {l.label}
        </NavLink>
      ))}
      {bar && (
        <span
          className="absolute bottom-0 h-0.5 bg-acc transition-all duration-200 ease-out"
          style={{ left: bar.left, width: bar.width }}
          aria-hidden
        />
      )}
    </nav>
  );
}

const PAGE_TITLES: [RegExp, string][] = [
  [/^\/setup/, "Setup"],
  [/^\/todos/, "To-do"],
  [/^\/tasks\//, "Task"],
  [/^\/chat/, "Chat"],
  [/^\/agents/, "Agents"],
  [/^\/history/, "History"],
  [/^\/memory/, "Memory"],
  [/^\/settings/, "Settings"],
  [/^\/$/, "Home"],
];

/** The tab itself signals when attention is needed — and never when it isn't. */
function useDocumentTitle(pendingCount: number) {
  const location = useLocation();
  useEffect(() => {
    const page = PAGE_TITLES.find(([re]) => re.test(location.pathname))?.[1];
    const prefix = pendingCount > 0 ? `(${pendingCount}) ` : "";
    document.title = `${prefix}${page ? `${page} — ` : ""}ami`;
  }, [location.pathname, pendingCount]);
}

export default function App() {
  useSse();
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const { data: pendingQuestions = [] } = useQuery({
    queryKey: ["questions"],
    queryFn: api.questions,
    refetchInterval: 10000,
  });
  useDocumentTitle(pendingQuestions.length);

  if (setup.isLoading) return <div className="p-12 text-mut">Starting ami…</div>;
  const needsSetup = setup.data && !setup.data.onboarded;

  return (
    <div className="min-h-screen">
      <header className="border-b border-edge2 bg-panel sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-6">
          <span className="text-lg font-semibold tracking-tight">
            ami<span className="text-acc">.</span>
          </span>
          {/* During onboarding the header is just the wordmark — no places to
           * wander off to until setup is done. */}
          {!needsSetup && (
            <>
              <HeaderNav />
              <span className="ml-auto flex items-center gap-3">
                <GlobalSearch />
                <QuestionsBadge questions={pendingQuestions} />
              </span>
            </>
          )}
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Routes>
          <Route path="/setup" element={<Onboarding />} />
          <Route
            path="/"
            element={needsSetup ? <Navigate to="/setup" replace /> : <Home />}
          />
          <Route path="/todos" element={<TodoList />} />
          <Route path="/tasks/:todoId" element={<TaskDetail />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/chat/:sessionId" element={<Chat />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/history" element={<History />} />
          <Route path="/memory" element={<MemoryGraph />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <Toasts />
    </div>
  );
}
