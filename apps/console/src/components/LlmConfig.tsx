import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";
import { SegmentedControl } from "./ui";

/** The one model-config surface, shared by onboarding and settings. Three
 * modes — a Claude key against Anthropic, a hosted Anthropic-compatible
 * endpoint, or a local proxy — each with its own copy, fields and a single
 * save. Everything maps to the same settings (`llm_mode`, `llm_base_url`,
 * `anthropic_api_key`, `model`, `kg_model`); the mode just shapes the form. */

type Mode = "anthropic" | "hosted" | "local";

const MODEL_OPTIONS = [
  { id: "claude-opus-4-8", label: "Opus — most capable" },
  { id: "claude-sonnet-4-6", label: "Sonnet — balanced" },
  { id: "claude-haiku-4-5", label: "Haiku — fastest, cheapest" },
];

export function LlmConfig({ variant = "settings" }: { variant?: "onboarding" | "settings" }) {
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const qc = useQueryClient();

  const [mode, setMode] = useState<Mode>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("claude-opus-4-8");
  const [kgModel, setKgModel] = useState("claude-sonnet-4-6");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Seed the fields from the saved config once it loads (guarded so refetches
  // after a save — or edits in another field — don't clobber what's typed).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !setup.data) return;
    seeded.current = true;
    setMode(setup.data.mode);
    setBaseUrl(setup.data.baseUrl);
    setModel(setup.data.model);
    setKgModel(setup.data.kgModel);
  }, [setup.data]);

  const hasApiKey = setup.data?.hasApiKey ?? false;

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.saveLlmConfig({
        mode,
        baseUrl: mode === "anthropic" ? "" : baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        kgModel: kgModel.trim(),
      });
      if (!res.ok) throw new Error(res.error ?? "save failed");
    },
    onSuccess: async () => {
      setError(null);
      setApiKey("");
      if (variant === "settings") toast("Model provider saved");
      await qc.invalidateQueries({ queryKey: ["setup"] });
    },
    onError: (e) => {
      const msg = errMsg(e);
      setError(msg);
      if (variant === "settings") toast.error(`Failed: ${msg}`);
    },
  });

  const keyRequired = mode !== "local" && !hasApiKey;
  const canSave =
    !save.isPending &&
    (mode === "anthropic" || baseUrl.trim().length > 0) &&
    (!keyRequired || apiKey.trim().length > 0);

  const keyPlaceholder = hasApiKey
    ? "API key set — paste to rotate"
    : mode === "local"
      ? "leave blank if your proxy needs none"
      : mode === "hosted"
        ? "your provider's key"
        : "sk-ant-…";

  return (
    <div className="space-y-4">
      <SegmentedControl<Mode>
        label="Model provider"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        options={[
          { value: "anthropic", label: "Claude API key" },
          { value: "hosted", label: "Hosted model" },
          { value: "local", label: "Local model" },
        ]}
      />

      {mode === "anthropic" && (
        <p className="text-sm text-mut">
          Ami runs on your Claude key. Get one at{" "}
          <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer" className="text-acc">
            platform.claude.com
          </a>
          . It never leaves this machine.
        </p>
      )}
      {mode === "hosted" && (
        <p className="text-sm text-mut">
          Point Ami at any Anthropic-compatible endpoint — hosted open models (Kimi, GLM, DeepSeek) or a
          LiteLLM proxy. Enter the endpoint, the model names it serves, and its key.
        </p>
      )}
      {mode === "local" && (
        <p className="text-sm text-mut">
          Run a local Anthropic-compatible endpoint — a LiteLLM proxy in front of Ollama / vLLM / llama.cpp.
          (Native Ollama and LM Studio speak the OpenAI API, so they need a translating proxy.) The key is
          optional — most local proxies accept any token.
        </p>
      )}

      {mode !== "anthropic" && (
        <label className="block">
          <span className="block text-xs text-mut mb-1">Endpoint</span>
          <input
            className="input"
            placeholder={mode === "local" ? "http://localhost:4000" : "https://…"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <ModelField
          label="Model for triage & task runs"
          value={model}
          onChange={setModel}
          select={mode === "anthropic"}
        />
        <ModelField
          label="Model for memory agents"
          hint="runs on every substantive signal"
          value={kgModel}
          onChange={setKgModel}
          select={mode === "anthropic"}
        />
      </div>

      <label className="block">
        <span className="block text-xs text-mut mb-1">
          API key{mode === "local" && <span className="text-mut"> (optional)</span>}
        </span>
        <input
          className="input"
          type="password"
          placeholder={keyPlaceholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) save.mutate();
          }}
        />
      </label>

      {error && <p className="text-sm text-bad">{error}</p>}

      <button className="btn btn-primary" disabled={!canSave} onClick={() => save.mutate()}>
        {save.isPending ? "Validating…" : "Save"}
      </button>
    </div>
  );
}

/** The model to run. In Claude mode only the known Claude models are valid, so
 * it's a dropdown; against a hosted/local endpoint the name is whatever the
 * provider serves, so it's free text with the Claude models as suggestions. */
function ModelField({
  label,
  hint,
  value,
  onChange,
  select,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  select?: boolean;
}) {
  const listId = useId();
  // Keep an off-list value (e.g. a legacy or custom name) selectable.
  const options = MODEL_OPTIONS.some((m) => m.id === value)
    ? MODEL_OPTIONS
    : [{ id: value, label: value }, ...MODEL_OPTIONS];
  return (
    <label className="block">
      <span className="block text-xs text-mut mb-1">
        {label}
        {hint && <span className="text-mut"> · {hint}</span>}
      </span>
      {select ? (
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input className="input" list={listId} value={value} onChange={(e) => onChange(e.target.value)} />
          <datalist id={listId}>
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </>
      )}
    </label>
  );
}
