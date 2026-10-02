const id = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);
const messageId = value => id(value, 'om');
const threadId = value => messageId(value) || id(value, 'omt');

function contextKeys(event) {
  const keys = [`message:${event.message_id ?? event.id}`];
  for (const field of ['parent_id', 'root_id', 'reply_to']) {
    const value = event[field];
    if (value === undefined || value === null || value === '') continue;
    if (!messageId(value)) return null;
    keys.push(`message:${value}`);
  }
  if (event.thread_id) {
    if (!threadId(event.thread_id)) return null;
    keys.push(`thread:${event.thread_id}`);
  }
  if (event.synthetic_callback) {
    if (!messageId(event.action_source_job_id)) return null;
    keys.push(`message:${event.action_source_job_id}`);
  }
  return [...new Set(keys)];
}

// Only the accepting IO may declare an independent request. Never read a lane
// key from message text, attachment data or an externally supplied event field.
export function acceptedDispatchLane(event, dependencyKey) {
  if (!id(event.chat_id, 'oc') || !id(event.sender_id, 'ou')
      || !messageId(event.message_id ?? event.id)) return null;
  const context = contextKeys(event);
  if (!context || (dependencyKey !== undefined && dependencyKey !== null
      && (typeof dependencyKey !== 'string' || !dependencyKey.length || dependencyKey.length > 512))) return null;
  return { version: 1, chatId: event.chat_id, senderId: event.sender_id,
    dependencyKey: dependencyKey ?? null, context };
}

function currentLane(job) {
  const lane = job.dispatchLane;
  // Old durable records retain FIFO behavior even if their events happen to
  // contain enough fields. Restart/configuration changes cannot reclassify them.
  if (lane?.version !== 1 || !id(lane.chatId, 'oc') || !id(lane.senderId, 'ou')
      || !Array.isArray(lane.context) || !lane.context.length
      || !lane.context.every(key => typeof key === 'string' && /^(?:message:om_|thread:(?:om|omt)_)[A-Za-z0-9_-]+$/.test(key))
      || (lane.dependencyKey !== null && (typeof lane.dependencyKey !== 'string' || !lane.dependencyKey.length || lane.dependencyKey.length > 512))) return null;
  const context = new Set(lane.context);
  // Preparation can recover relationships omitted by a compact subscriber.
  // Keep accepted relationships too: enrichment must never weaken ordering.
  for (const event of [job.event, job.prepared]) {
    if (!event) continue;
    if (event.chat_id !== lane.chatId || event.sender_id !== lane.senderId
        || (event.message_id ?? event.id) !== job.id) return null;
    const keys = contextKeys(event);
    if (!keys) return null;
    for (const key of keys) context.add(key);
  }
  return { ...lane, context: [...context] };
}

// Resolve reply chains through durable history, including already submitted
// parents. Sender edges are deliberately excluded from this graph: a historical
// conversation between two people must not join all their future requests.
export function dispatchDependencies(jobs, contextVerified, requireCandidateVerified = false) {
  const lanes = new Map(), verified = new Map(), parents = new Map();
  const find = key => {
    if (!parents.has(key)) parents.set(key, key);
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root);
    while (key !== root) { const next = parents.get(key); parents.set(key, root); key = next; }
    return root;
  };
  for (const job of jobs) {
    const lane = currentLane(job); lanes.set(job, lane);
    let trusted = !contextVerified;
    if (contextVerified) {
      try { trusted = contextVerified(job.event, job.prepared, job) === true; } catch { trusted = false; }
    }
    verified.set(job, trusted);
    if (!lane) continue;
    const keys = lane.context.map(key => JSON.stringify([lane.chatId, key]));
    const root = find(keys[0]);
    for (const key of keys.slice(1)) parents.set(find(key), root);
  }
  return (first, second) => {
    const a = lanes.get(first), b = lanes.get(second);
    if (!a || !b) return true; // Unknown/legacy records are FIFO barriers.
    // A compact event with omitted relationships may be tentatively prepared,
    // but may pass earlier work only after the native lookup proved its context.
    // An unavailable lookup cannot turn missing fields into independence.
    if (!verified.get(first) || (!verified.get(second)
        && (requireCandidateVerified || second.prepared !== undefined || second.attempts > 0))) return true;
    if (a.chatId !== b.chatId) return false;
    if (find(JSON.stringify([a.chatId, a.context[0]])) === find(JSON.stringify([b.chatId, b.context[0]]))) return true;
    if (a.dependencyKey !== null && a.dependencyKey === b.dependencyKey) return true;
    return a.senderId === b.senderId
      && !(a.dependencyKey !== null && b.dependencyKey !== null && a.dependencyKey !== b.dependencyKey);
  };
}

export function nextDispatchJob(jobs, now, contextVerified) {
  const all = [...jobs], first = all.find(job => job.status === 'queued');
  if (!first || (first.retryAt ?? 0) <= now) return first ?? null;
  // The common FIFO path needs no history graph; build it only to bypass an
  // actual preparation backoff.
  const dependent = dispatchDependencies(all, contextVerified), prior = [];
  for (const job of all) {
    if (job.status !== 'queued') continue;
    if ((job.retryAt ?? 0) <= now && !prior.some(other => dependent(other, job))) return job;
    // Include ready-but-dependent jobs so their later supplements cannot leap
    // through a blocked chain merely because their own retryAt is already due.
    prior.push(job);
  }
  return null;
}

export function hasPriorDispatchDependency(jobs, selected, contextVerified) {
  const all = [...jobs], index = all.indexOf(selected);
  if (index < 0) return true;
  const prior = all.slice(0, index).filter(job => job.status === 'queued');
  if (!prior.length) return false;
  const dependent = dispatchDependencies(all, contextVerified, true);
  return prior.some(job => dependent(job, selected));
}
