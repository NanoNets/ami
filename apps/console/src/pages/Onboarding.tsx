import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ConnectorCards } from "./Settings";
import { LlmConfig } from "../components/LlmConfig";
import { CheckIcon, EyeIcon, LockIcon, SearchIcon, ZapIcon } from "../components/icons";

/** First run: one hero promise, a three-step rail, and exactly one thing to do
 * at a time. Completed steps collapse to a single ✓ line so the page never
 * grows into a stack of finished forms. */

function HeroPoint({
  icon,
  title,
  text,
  delay,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  delay: number;
}) {
  return (
    <div className="flex items-start gap-3 rise" style={{ animationDelay: `${delay}ms` }}>
      <span className="w-7 h-7 rounded-soft bg-acc/10 text-acc inline-flex items-center justify-center shrink-0">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-[13px] text-mut leading-relaxed mt-0.5">{text}</p>
      </div>
    </div>
  );
}

/** The three-stop rail: you can always see how much is left. */
function ProgressRail({ steps }: { steps: { label: string; done: boolean; active: boolean }[] }) {
  return (
    <div className="flex items-center justify-center mb-10">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center">
          {i > 0 && <div className={`h-px w-10 mx-3 transition-colors duration-300 ${s.done || s.active ? "bg-acc" : "bg-edge2"}`} />}
          <span
            className={`flex items-center gap-1.5 text-xs transition-colors ${
              s.done ? "text-ok" : s.active ? "text-hi font-medium" : "text-mut"
            }`}
          >
            {s.done ? (
              <CheckIcon />
            ) : (
              <span
                className={`w-4 h-4 border rounded-full text-[10px] leading-none inline-flex items-center justify-center ${
                  s.active ? "border-acc text-acc" : "border-edge2"
                }`}
              >
                {i + 1}
              </span>
            )}
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function StepCard({
  title,
  done,
  doneSummary,
  children,
}: {
  title: string;
  done: boolean;
  doneSummary?: string;
  children: ReactNode;
}) {
  const [reopened, setReopened] = useState(false);
  const collapsed = done && !reopened;
  useEffect(() => {
    // A step that becomes un-done (e.g. identity edited) re-expands itself.
    if (!done) setReopened(false);
  }, [done]);

  if (collapsed)
    return (
      <div className="card px-6 py-3 mb-6 flex items-center gap-2 rise">
        <span className="text-ok shrink-0">
          <CheckIcon />
        </span>
        <span className="font-medium text-sm">{title}</span>
        {doneSummary && <span className="text-xs text-mut truncate">{doneSummary}</span>}
        <button className="text-xs text-mut hover:text-hi ml-auto shrink-0 cursor-pointer" onClick={() => setReopened(true)}>
          edit
        </button>
      </div>
    );
  return (
    <div className="card p-6 mb-6 rise">
      <h2 className="font-medium mb-1">
        {title}{" "}
        {done && (
          <span className="text-ok text-sm inline-flex items-center gap-1">
            <CheckIcon /> done
          </span>
        )}
      </h2>
      {children}
    </div>
  );
}

export default function Onboarding() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const connectors = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors,
    // Poll until Slack is in. Google is optional and connects via an OAuth
    // callback in another tab, so keep polling while it (or Slack) is pending.
    refetchInterval: (q) => {
      const done = (id: string) => q.state.data?.some((c) => c.connector === id && c.connected);
      return done("slack") ? false : 3000;
    },
  });
  const isConnected = (id: string) => connectors.data?.some((c) => c.connector === id && c.connected) ?? false;
  const googleDone = isConnected("gmail");
  const slackDone = isConnected("slack");
  // Slack is the only mandatory tool; Google is offered under "connect more".
  const coreDone = slackDone;

  // Re-fetch identity when a core tool connects: the server pre-fills
  // name/email/domain from whichever account arrives first.
  const identity = useQuery({ queryKey: ["identity", googleDone, slackDone], queryFn: api.identity });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [domain, setDomain] = useState("");
  const [domainEdited, setDomainEdited] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  useEffect(() => {
    if (identity.data) {
      setName((v) => v || identity.data.name);
      setEmail((v) => v || identity.data.email);
      if (identity.data.domain) {
        setDomain((v) => v || identity.data.domain);
        setDomainEdited(true);
      }
    }
  }, [identity.data]);
  const emailValid = /.+@.+\..+/.test(email.trim());
  // Follow the email's domain until the user types their own (e.g. personal
  // gmail address but a company domain).
  useEffect(() => {
    if (!domainEdited && emailValid) setDomain(email.trim().toLowerCase().split("@")[1] ?? "");
  }, [email, emailValid, domainEdited]);
  const domainValid = /^[^\s@]+\.[^\s@]+$/.test(domain.trim());
  const identityDone = !!(identity.data?.name && identity.data?.email && identity.data?.domain);
  const identityDirty =
    !!identity.data &&
    (name.trim() !== identity.data.name || email.trim() !== identity.data.email || domain.trim() !== identity.data.domain);

  async function saveIdentity() {
    setSavingIdentity(true);
    try {
      await api.saveIdentity({ name: name.trim(), email: email.trim(), domain: domain.trim() });
      await qc.invalidateQueries({ queryKey: ["identity", googleDone, slackDone] });
    } finally {
      setSavingIdentity(false);
    }
  }

  const keyDone = setup.data?.llmReady ?? false;
  const ready = keyDone && coreDone && identityDone;

  // When a step completes it collapses to its ✓ line — scroll the newly
  // revealed step into view so the user lands on the next thing to do.
  const toolsRef = useRef<HTMLDivElement>(null);
  const identityRef = useRef<HTMLDivElement>(null);
  const finishRef = useRef<HTMLDivElement>(null);
  const prevSteps = useRef<{ key: boolean; core: boolean; identity: boolean } | null>(null);
  useEffect(() => {
    // Wait for all three queries so a half-done returning user doesn't get
    // scroll-jumped on load; only transitions after that first snapshot scroll.
    if (!setup.data || !connectors.data || !identity.data) return;
    const cur = { key: keyDone, core: coreDone, identity: identityDone };
    const prev = prevSteps.current;
    prevSteps.current = cur;
    if (!prev) return;
    const completed =
      (!prev.key && cur.key) || (!prev.core && cur.core) || (!prev.identity && cur.identity);
    if (!completed) return;
    const target = !keyDone ? null : !coreDone ? toolsRef : !identityDone ? identityRef : finishRef;
    // Next frame: the revealed step mounts on this render pass.
    requestAnimationFrame(() =>
      target?.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }, [setup.data, connectors.data, identity.data, keyDone, coreDone, identityDone]);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8 rise">
        <h1 className="text-3xl font-semibold">
          ami<span className="text-acc">.</span>
        </h1>
        <p className="text-mut mt-2">Your AI clone.</p>
      </div>

      {/* the promise, in four beats */}
      <div className="max-w-lg mx-auto space-y-5 mb-12">
        <HeroPoint
          icon={<EyeIcon size={15} />}
          title="Learns your world"
          text="Watches your apps and data, memorizes how you work and talk, and builds an exhaustive context graph of you."
          delay={100}
        />
        <HeroPoint
          icon={<SearchIcon size={15} />}
          title="Everything in one place"
          text="Tasks, emails, mentions, meetings, all gathered together. All the apps and data you can reach becomes queryable."
          delay={200}
        />
        <HeroPoint
          icon={<ZapIcon size={15} />}
          title="Acts on your behalf"
          text="Performs actions, posts replies, completes tasks end-to-end, acting as you either autonomously or in iterations with your feedback."
          delay={300}
        />
        <HeroPoint
          icon={<LockIcon size={15} />}
          title="Yours, and only yours"
          text="No telemetry. Nothing ships and nothing sends without your final go-ahead."
          delay={400}
        />
      </div>

      <ProgressRail
        steps={[
          { label: "LLM", done: keyDone, active: !keyDone },
          { label: "Tools", done: coreDone, active: keyDone && !coreDone },
          { label: "Identity", done: identityDone, active: keyDone && coreDone && !identityDone },
        ]}
      />

      <StepCard title="Model" done={keyDone} doneSummary={setup.data?.baseUrl || undefined}>
        <LlmConfig variant="onboarding" />
      </StepCard>

      {keyDone && (
        <div ref={toolsRef} className="scroll-mt-6">
        <StepCard title="Slack" done={coreDone}>
          <p className="text-sm text-mut mb-4">
            Ami starts learning your world from your Slack. Connect it to continue — you can add Gmail, Calendar and more in the next step.
          </p>
          <ConnectorCards only={["slack"]} autoOpenSlackChannels />
        </StepCard>
        </div>
      )}

      {(googleDone || slackDone) && (
        <div ref={identityRef} className="scroll-mt-6">
        <StepCard
          title="Who are you?"
          done={identityDone && !identityDirty}
          doneSummary={identity.data ? `${identity.data.name} · ${identity.data.email}` : undefined}
        >
          <p className="text-sm text-mut mb-3">
            Ami reads everything from your point of view — this is who "you" are. Fix anything that looks off.
          </p>
          <div className="grid sm:grid-cols-3 gap-2">
            <label className="block">
              <span className="block text-xs text-mut mb-1">Name</span>
              <input className="input" placeholder="Ada Lovelace" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="block text-xs text-mut mb-1">Email</span>
              <input
                className="input"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-mut mb-1">Company domain</span>
              <input
                className="input"
                placeholder="company.com"
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value);
                  setDomainEdited(true);
                }}
              />
            </label>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <p className="text-xs text-mut">Anyone sending from this domain is treated as your teammate.</p>
            {(!identityDone || identityDirty) && (
              <button
                className="btn btn-primary shrink-0 ml-auto"
                disabled={!name.trim() || !emailValid || !domainValid || savingIdentity}
                onClick={saveIdentity}
              >
                {savingIdentity ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </StepCard>
        </div>
      )}

      {ready && (
        <div ref={finishRef} className="card p-6 mb-6 rise scroll-mt-6">
          <h2 className="font-medium mb-1">
            (Optional) Connect more tools
          </h2>
          <p className="text-sm text-mut mb-4">
            Connecting Gmail and Calendar is highly recommended — along with any other tools you frequently use. You can also add them later in Settings.
          </p>
          <ConnectorCards exclude={["slack"]} compact />
        </div>
      )}

      {ready && (
        <div className="card p-6 mb-6 text-center rise">
          <button
            className="btn btn-primary px-6 py-2"
            onClick={async () => {
              await api.completeSetup();
              await qc.invalidateQueries({ queryKey: ["setup"] });
              navigate("/");
            }}
          >
            Start ami →
          </button>
          <p className="text-xs text-mut mt-2">
            Ami begins reading your tools, builds your context graph and to-do list, and opens homepage.
          </p>
        </div>
      )}
    </div>
  );
}
