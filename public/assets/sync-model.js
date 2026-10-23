import { createState, importState } from './learning-engine.js';

export const APP_ID = 'chinese-literacy-g1';
export const SETTINGS_KEYS = ['minutes', 'teacherOrder', 'newLimit', 'includeRecognition'];
export function initialState() {
  const state = createState();
  state.settings.includeRecognition = true;
  return state;
}

// Old backups have no event IDs. Identical imports must converge on the same IDs.
function identify(events, scope) {
  const counts = new Map();
  return events.map((event, index) => {
    if (event.id) return { ...event };
    const key = [scope, String(index).padStart(5, '0'), event.date, event.result ?? event.minutes, event.mode || '', event.reason || ''].map(value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)).join(':');
    const occurrence = counts.get(key) || 0;
    counts.set(key, occurrence + 1);
    return { ...event, id: `legacy:${key}:${occurrence}` };
  });
}
export function normalizeState(state, knownIds) {
  const clean = importState(JSON.stringify(state), knownIds);
  return { ...clean, records: Object.fromEntries(Object.entries(clean.records).map(([id, record]) => [id, {
    studiedDates: [...record.studiedDates], attempts: identify(record.attempts, id),
  }])), sessions: identify(clean.sessions, 'time') };
}
function signature(event) {
  return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
}
function unionEvents(a, b) {
  const events = new Map();
  for (const event of [...a, ...b]) {
    if (events.has(event.id) && signature(events.get(event.id)) !== signature(event)) throw new Error('同一条记录内容冲突，请先导出备份。');
    events.set(event.id, event);
  }
  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.at || '').localeCompare(b.at || '') || a.id.localeCompare(b.id));
}
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !SETTINGS_KEYS.includes(key))) throw new Error('学习设置字段不合法。');
  const state = initialState();
  state.settings = { ...state.settings, ...patch };
  importState(JSON.stringify(state));
  if (state.settings.teacherOrder > 40) throw new Error('老师进度超出本册范围。');
  return { ...patch };
}
/** Records are additive; only an explicit settings patch may change cloud settings. */
export function mergeStates(remote, local, settingsPatch = {}, knownIds) {
  const a = normalizeState(remote, knownIds), b = normalizeState(local, knownIds);
  const merged = { ...a, settings: { ...a.settings, ...validateSettingsPatch(settingsPatch) }, records: { ...a.records }, sessions: unionEvents(a.sessions, b.sessions).slice(-3660) };
  for (const [id, record] of Object.entries(b.records)) {
    const old = merged.records[id] || { studiedDates: [], attempts: [] };
    merged.records[id] = {
      studiedDates: [...new Set([...old.studiedDates, ...record.studiedDates])].sort(),
      attempts: unionEvents(old.attempts, record.attempts),
    };
  }
  return importState(JSON.stringify(merged), knownIds);
}
/** Small immutable outbox entries keep offline work durable without full snapshots per click. */
export function stateDelta(before, after, knownIds) {
  const a = normalizeState(before, knownIds), b = normalizeState(after, knownIds);
  const delta = initialState();
  for (const [id, record] of Object.entries(b.records)) {
    const old = a.records[id] || { studiedDates: [], attempts: [] };
    const oldEvents = new Set(old.attempts.map(event => event.id));
    const studiedDates = record.studiedDates.filter(date => !old.studiedDates.includes(date));
    const attempts = record.attempts.filter(event => !oldEvents.has(event.id));
    if (studiedDates.length || attempts.length) delta.records[id] = { studiedDates, attempts };
  }
  const oldSessions = new Set(a.sessions.map(event => event.id));
  delta.sessions = b.sessions.filter(event => !oldSessions.has(event.id));
  return delta;
}
