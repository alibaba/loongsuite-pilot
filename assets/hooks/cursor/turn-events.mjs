/** Classify stops and expired metadata from an immutable journal snapshot. */
export function inspectTurnJournal(events, staleBefore) {
  const promptsByConversation = new Map();
  const lastSessionEnd = new Map();
  events.forEach((event, index) => {
    const id = event.conversation_id;
    if (event.hook_event === 'beforeSubmitPrompt') {
      let prompts = promptsByConversation.get(id);
      if (!prompts) {
        prompts = { firstIndex: index, generations: new Set() };
        promptsByConversation.set(id, prompts);
      }
      if (event.generation_id) prompts.generations.add(event.generation_id);
    } else if (event.hook_event === 'sessionEnd') {
      lastSessionEnd.set(id, index);
    }
  });

  const stops = [];
  const remaining = events.filter((event, index) => {
    const id = event.conversation_id;
    const prompts = promptsByConversation.get(id);
    if (event.hook_event === 'stop') {
      const canAssemble = prompts && (event.generation_id && prompts.generations.size > 0
        ? prompts.generations.has(event.generation_id)
        : prompts.firstIndex <= index);
      if (canAssemble) {
        stops.push(event);
        return true;
      }
      // An early Stop can precede its prompt. Give it a bounded opportunity
      // to pair without repeatedly reading the journal or logging duplicates.
      return Date.parse(event._journal_ts) > staleBefore;
    }
    const isSessionBoundary = event.hook_event === 'sessionStart' || event.hook_event === 'sessionEnd';
    if (isSessionBoundary && !prompts) {
      return (lastSessionEnd.get(id) ?? -1) < index && Date.parse(event._journal_ts) > staleBefore;
    }
    return true;
  });
  return { stops, remaining };
}

/** Select one prompt generation without consuming its conversation's next turn. */
export function selectTurnEvents(events, stop) {
  const conversation = events.filter(e => e.conversation_id === stop.conversation_id);
  const stopIndex = conversation.findIndex(e => e.hook_event === 'stop'
    && e._journal_ts === stop._journal_ts && e.generation_id === stop.generation_id);
  if (stopIndex < 0) return [];
  const prompts = conversation.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.hook_event === 'beforeSubmitPrompt');
  const matchingPrompt = stop.generation_id
    ? prompts.find(p => p.event.generation_id === stop.generation_id) : undefined;
  // A repeated stop for an already consumed generation must not claim a new
  // prompt simply because it is now the only prompt in the conversation.
  if (stop.generation_id && !matchingPrompt && prompts.some(p => p.event.generation_id)) return [];
  const prompt = matchingPrompt ?? prompts.filter(p => p.index <= stopIndex).at(-1);
  if (!prompt) return [];
  const next = prompts.find(p => p.index > prompt.index);
  const parentEvents = conversation.filter((event, index) => {
    // Late responses can arrive after the following prompt. Known generation
    // IDs take priority over position; unversioned events use prompt boundaries.
    const generation = event.hook_event === 'afterAgentThought'
      ? event.generation_id?.replace(/-\d+-[a-z0-9]{4,}$/i, '') : event.generation_id;
    const generationPrompt = event.generation_id
      ? prompts.find(p => p.event.generation_id === event.generation_id || p.event.generation_id === generation) : undefined;
    if (generationPrompt) return generationPrompt === prompt;
    // A new generation's tools may beat its prompt to the journal. Keep them
    // pending rather than attributing them to the previous generation.
    if (event.generation_id && prompt.event.generation_id) return false;
    return index >= prompt.index && (!next || index < next.index);
  });
  const parentSet = new Set(parentEvents);
  const start = prompt.event._journal_ts;
  const end = next?.event._journal_ts;
  return events.filter(event => event.conversation_id === stop.conversation_id
    ? parentSet.has(event)
    : event._journal_ts >= start && (!end || event._journal_ts < end));
}
