import { z } from "zod";
import { insertLlmUsage, insertSignal, insertTodo, insertTrace, markTriaged, type Db } from "@ami/db";
import { anthropicClient, buildOwnerBlock, kgModel, parseWithSchema, readNote } from "@ami/memory";
import { WRITING_STYLE, type AmiEvent } from "@ami/shared";

type Publish = (e: AmiEvent) => void;

/** Turn a new meeting's notes into to-dos: action items owned by the user
 * become tasks; other notable outcomes become FYIs. One structured kg-model
 * call per meeting. (Entity/dossier updates happen separately via the
 * note-creation agent, which processes the meeting note as a source.) */

const MeetingItemsSchema = z.object({
  actionItems: z.array(
    z.object({
      title: z.string().describe("Short imperative title as the user would write it"),
      summary: z.string().describe("1-2 sentences with the key facts needed to act, incl. who asked/agreed"),
      mine: z
        .boolean()
        .describe("true only when the OWNER committed to it or it was clearly assigned to them; commitments by other attendees are not the owner's tasks"),
    }),
  ),
  fyis: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
    }),
  ).describe("Decisions or outcomes worth surfacing that need no action from the owner (max 3, often zero)"),
});

const SYSTEM = `You extract the user's action items from meeting notes for their to-do list.

Rules:
- An action item is MINE only when the owner (see Owner block) committed to it or it was explicitly assigned to them. "Sarah will send the deck" is Sarah's, not the owner's — at most an FYI if consequential.
- Be conservative: vague intentions ("we should think about X") are not action items. Concrete commitments with a deliverable are.
- Deadlines and who-asked go in the summary. Use absolute dates.
- FYIs are for decisions/outcomes the owner should know about but needn't act on. Most meetings produce 0-2.

${WRITING_STYLE}`;

export async function processMeetingActionItems(
  db: Db,
  publish: Publish,
  meeting: { title: string; when: string; notePath: string },
): Promise<{ tasks: number; fyis: number }> {
  const client = anthropicClient(db);
  if (!client || process.env.AMI_FAKE_LLM === "1") return { tasks: 0, fyis: 0 };
  const notes = readNote(meeting.notePath);
  if (!notes || notes.length < 200) return { tasks: 0, fyis: 0 }; // nothing substantive

  const model = kgModel(db);
  const res = await parseWithSchema(
    db,
    client,
    {
      model,
      max_tokens: 3000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `${buildOwnerBlock(db)}\n\nMeeting: ${meeting.title}\nWhen: ${meeting.when}\n\nNotes:\n\n${notes.slice(0, 20000)}`,
        },
      ],
    },
    MeetingItemsSchema,
  );
  insertLlmUsage(db, {
    useCase: "meeting_items",
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
  });
  const out = res.parsed_output;
  if (!out) return { tasks: 0, fyis: 0 };

  const mine = out.actionItems.filter((i) => i.mine);
  const fyiItems = out.fyis.slice(0, 3);

  // One synthetic, pre-triaged signal shared by every todo from this meeting,
  // so cards carry a source (meeting name + date + icon) like connector-
  // sourced ones — same pattern as chat-created todos.
  let sigId: string | null = null;
  if (mine.length > 0 || fyiItems.length > 0) {
    const at = new Date(meeting.when);
    const dateLabel = isNaN(at.getTime())
      ? meeting.when
      : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    sigId = insertSignal(db, "meeting", null, {
      externalId: `meeting:${meeting.notePath}`,
      kind: "message",
      title: `Meeting: ${meeting.title}`,
      body: `Action items extracted from meeting notes: knowledge/${meeting.notePath}`,
      author: `${meeting.title} · ${dateLabel}`,
      raw: null,
      occurredAt: isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    });
    if (sigId) markTriaged(db, [sigId]);
  }

  let tasks = 0;
  for (const item of mine) {
    const todoId = insertTodo(db, {
      type: "task",
      title: item.title,
      summary: `${item.summary} (from meeting "${meeting.title}" — knowledge/${meeting.notePath})`,
      signalId: sigId,
      entityIds: [],
    });
    insertTrace(db, {
      todoId,
      kind: "triage",
      situation: `Meeting: ${meeting.title}`,
      decision: `task: ${item.title}`,
    });
    publish({ type: "todo.created", todoId });
    tasks++;
  }
  let fyis = 0;
  for (const fyi of fyiItems) {
    const todoId = insertTodo(db, {
      type: "fyi",
      title: fyi.title,
      summary: `${fyi.summary} (from meeting "${meeting.title}")`,
      signalId: sigId,
      entityIds: [],
    });
    publish({ type: "todo.created", todoId });
    fyis++;
  }
  console.log(`[meetings] "${meeting.title}": ${tasks} task(s), ${fyis} fyi(s)`);
  return { tasks, fyis };
}
