/**
 * A small learning scheduler for 一年级上册语文.
 * “Stable” is a description of recorded delayed recall, not a prediction of grades.
 * Stored facts are study dates and attempts; mastery is always derived from them.
 */
export const STORAGE_KEY = 'chinese-literacy-g1:progress:v1';
const APP_ID = 'chinese-literacy-g1';
const DAY = 86_400_000;
const RESULTS = new Set(['pass', 'hint', 'fail']);
const MODES = new Set(['quiz', 'review']);
const ERROR_REASONS = new Set(['字形/笔画', '读音/声调', '拼写顺序', '暂时想不起来']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const INTERVALS = [0, 1, 3, 7, 14];
const LABELS = ['待巩固', '初步记住', '隔日通过', '间隔巩固', '稳定掌握'];
const MINUTES_PER_STUDY = 1.5;
const MINUTES_PER_TEST = 1.5;

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireDate(value) {
  insist(validDate(value), '日期必须是有效的 YYYY-MM-DD，例如 2026-10-23。');
  return value;
}

/** Use the child's device-local calendar day, rather than UTC midnight. */
export function dateKey(date = new Date()) {
  insist(date instanceof Date && Number.isFinite(date.getTime()), '无法读取有效日期。');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function addDays(date, count) {
  requireDate(date);
  insist(Number.isInteger(count) && Math.abs(count) <= 36_600, '日期间隔不合法。');
  const result = new Date(new Date(`${date}T12:00:00.000Z`).getTime() + count * DAY);
  const resultKey = result.toISOString().slice(0, 10);
  requireDate(resultKey);
  return resultKey;
}

export function createState() {
  return {
    version: 1,
    settings: { minutes: 20, teacherOrder: 1, newLimit: 6, includeRecognition: false },
    records: {},
    sessions: [],
  };
}

function validItemId(id) {
  return typeof id === 'string' && id.length <= 100 && /^(write|pinyin|recognize):[^\u0000-\u001f\u007f]+$/u.test(id);
}

/** The first occurrence owns an item; each recognition pronunciation stays distinct. */
export function flattenCurriculum(curriculum) {
  insist(curriculum && Array.isArray(curriculum.lessons), '课程资料缺少 lessons。');
  const seen = new Set();
  const items = [];
  const ordered = [...curriculum.lessons].sort((a, b) => a.order - b.order);
  for (const lesson of ordered) {
    for (const kind of ['write', 'pinyin', 'recognize']) {
      for (const content of lesson[kind] || []) {
        insist(content && typeof content.text === 'string' && content.text.trim(), '课程内容缺少文字。');
        const text = content.text.trim().normalize('NFC');
        const pinyin = typeof content.pinyin === 'string' ? content.pinyin.trim().normalize('NFC') : '';
        insist(kind !== 'recognize' || pinyin.length > 0, '认读内容缺少读音，无法区分多音字。');
        const id = kind === 'recognize' ? `${kind}:${text}:${pinyin}` : `${kind}:${text}`;
        insist(validItemId(id), '课程内容标识不合法。');
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({
          id, kind, text, pinyin,
          lessonId: lesson.id, lessonOrder: lesson.order,
          unit: lesson.unit, title: lesson.title, page: lesson.page,
          sourcePages: [...(lesson.sourcePages || [])],
          content: { ...content, text, ...(pinyin ? { pinyin } : {}) },
        });
      }
    }
  }
  return items;
}

function blankRecord() {
  return { studiedDates: [], attempts: [] };
}

/**
 * Only the FIRST attempt on a date can advance a stage, and only when due.
 * Any hint/failure resets the sequence, even after a same-day successful attempt.
 * Relearning after an earlier testing date also resets the sequence. A subsequent
 * same-day answer is not an independent delayed recall, even if marked correct.
 * Earliest stable sequence: day 0 → day 1 → day 4 → day 11 (last gap ≥ 7 days).
 */
export function getItemStatus(record, today = dateKey()) {
  requireDate(today);
  const current = record || blankRecord();
  let stage = 0;
  let dueDate = null;
  let lastAttemptDate = null;
  let lastAdvancedDate = null;
  let lastResult = null;
  let lastRelearnedDate = null;
  // Merge study dates into the timeline. Studying alone can invalidate an old
  // mastery claim; it must not require a later quiz before taking effect.
  const studiedDates = (current.studiedDates || []).filter((date) => date <= today);
  const studyDays = new Set(studiedDates);
  const attemptsByDate = new Map();
  for (const attempt of current.attempts || []) {
    if (attempt.date > today) continue;
    if (!attemptsByDate.has(attempt.date)) attemptsByDate.set(attempt.date, []);
    attemptsByDate.get(attempt.date).push(attempt);
  }
  const dates = [...new Set([...studyDays, ...attemptsByDate.keys()])].sort();
  for (const date of dates) {
    if (studyDays.has(date) && lastAttemptDate !== null && lastAttemptDate < date) {
      stage = 0;
      dueDate = addDays(date, 1);
      lastRelearnedDate = date;
    }
    for (const [index, attempt] of (attemptsByDate.get(date) || []).entries()) {
      lastAttemptDate = attempt.date;
      lastResult = attempt.result;
      if (attempt.result !== 'pass') {
        stage = 0;
        dueDate = addDays(attempt.date, 1);
      } else if (index === 0 && (!dueDate || attempt.date >= dueDate)) {
        stage = Math.min(stage + 1, 4);
        dueDate = addDays(attempt.date, INTERVALS[stage]);
        lastAdvancedDate = attempt.date;
      }
    }
  }
  const studied = studiedDates.length > 0;
  return {
    stage,
    label: stage === 0 && !studied && !lastAttemptDate ? '待学习' : LABELS[stage],
    stable: stage === 4,
    isDue: dueDate !== null && dueDate <= today && lastAttemptDate !== today,
    dueDate,
    studied,
    needsQuiz: studied && lastAttemptDate === null,
    lastAttemptDate,
    lastAdvancedDate,
    lastResult,
    lastRelearnedDate,
    relearnedToday: lastRelearnedDate === today,
  };
}

function checkRecordChronology(record, date) {
  const lastAttempt = record.attempts.at(-1)?.date;
  const lastStudy = record.studiedDates.at(-1);
  insist((!lastAttempt || date >= lastAttempt) && (!lastStudy || date >= lastStudy), '设备日期早于已有学习记录，请先检查日期。');
}

export function markStudied(state, itemId, date = dateKey()) {
  requireDate(date);
  insist(validItemId(itemId), '学习内容标识不合法。');
  const old = state.records[itemId] || blankRecord();
  checkRecordChronology(old, date);
  if (old.studiedDates.includes(date)) return state;
  return {
    ...state,
    records: { ...state.records, [itemId]: { studiedDates: [...old.studiedDates, date], attempts: [...old.attempts] } },
  };
}

/** A “pass” must mean unprompted recall independently checked by the parent. */
export function recordAttempt(state, itemId, { date = dateKey(), result, mode = 'quiz', reason, id, at }) {
  requireDate(date);
  insist(validItemId(itemId), '学习内容标识不合法。');
  insist(RESULTS.has(result), '小测结果必须是独立答对、提示后答对或答错。');
  insist(MODES.has(mode), '小测类型不合法。');
  insist(reason === undefined || reason === '' || ERROR_REASONS.has(reason), '错误原因不合法。');
  const old = state.records[itemId] || blankRecord();
  checkRecordChronology(old, date);
  return {
    ...state,
    records: { ...state.records, [itemId]: { studiedDates: [...old.studiedDates], attempts: [...old.attempts, { date, result, mode, ...(reason ? { reason } : {}), ...(id ? { id } : {}), ...(at ? { at } : {}) }] } },
  };
}

function firstSeenDate(record) {
  return [...(record?.studiedDates || []), ...(record?.attempts || []).map((attempt) => attempt.date)].sort()[0] || null;
}

/** Daily capacity includes work already recorded today, so rebuilding cannot add endless work. */
export function buildDailyPlan(items, state, today = dateKey()) {
  requireDate(today);
  const { minutes, teacherOrder, newLimit, includeRecognition } = state.settings;
  const primaryOrder = { write: 0, pinyin: 1, recognize: 2 };
  const ordered = [...items].sort((a, b) => a.lessonOrder - b.lessonOrder || primaryOrder[a.kind] - primaryOrder[b.kind]);
  const eligible = ordered.filter((item) => item.lessonOrder <= teacherOrder && (includeRecognition || item.kind !== 'recognize'));
  const status = new Map(eligible.map((item) => [item.id, getItemStatus(state.records[item.id], today)]));
  const reviewCandidates = eligible.filter((item) => status.get(item.id).isDue)
    .sort((a, b) => status.get(a.id).dueDate.localeCompare(status.get(b.id).dueDate) || a.lessonOrder - b.lessonOrder);
  const quizCandidates = eligible.filter((item) => status.get(item.id).needsQuiz);
  let completedMinutes = 0;
  let newStartedToday = 0;
  // Count all recorded work, including work hidden after adjusting teacher progress.
  for (const record of Object.values(state.records)) {
    if (record.studiedDates.includes(today)) completedMinutes += MINUTES_PER_STUDY;
    if (record.attempts.some((attempt) => attempt.date === today)) completedMinutes += MINUTES_PER_TEST;
    if (firstSeenDate(record) === today) newStartedToday += 1;
  }
  let remainingMinutes = Math.max(0, minutes - completedMinutes);
  const take = (candidates, cost, limit = Infinity) => {
    const count = Math.min(candidates.length, Math.floor((remainingMinutes + 1e-9) / cost), limit);
    remainingMinutes -= count * cost;
    return candidates.slice(0, count);
  };
  // Finish the small test for already studied items before introducing new material.
  const quiz = take(quizCandidates, MINUTES_PER_TEST);
  const maxReview = Math.max(1, Math.floor(minutes * 0.5 / MINUTES_PER_TEST));
  const review = take(reviewCandidates, MINUTES_PER_TEST, maxReview);
  const unseen = eligible.filter((item) => firstSeenDate(state.records[item.id]) === null);
  const availableNew = Math.max(0, newLimit - newStartedToday);
  const recognitionCandidates = includeRecognition ? unseen.filter((item) => item.kind === 'recognize') : [];
  const primaryCandidates = unseen.filter((item) => item.kind !== 'recognize');
  // When selected, reserve one of the daily new slots for recognition.
  const reserveRecognition = recognitionCandidates.length && availableNew > 1 ? 1 : 0;
  const newItems = take(primaryCandidates, MINUTES_PER_STUDY + MINUTES_PER_TEST, availableNew - reserveRecognition);
  const recognition = take(recognitionCandidates, MINUTES_PER_STUDY + MINUTES_PER_TEST, availableNew - newItems.length);
  const estimatedMinutes = Math.round((Math.max(0, minutes - completedMinutes) - remainingMinutes) * 10) / 10;
  return {
    review, newItems, recognition, quiz,
    estimatedMinutes,
    completedMinutes,
    totalEstimatedMinutes: Math.round((completedMinutes + estimatedMinutes) * 10) / 10,
    overflowReviewCount: reviewCandidates.length - review.length,
    overflowQuizCount: quizCandidates.length - quiz.length,
    nextLesson: unseen[0] ? { id: unseen[0].lessonId, order: unseen[0].lessonOrder, title: unseen[0].title } : null,
    summary: {
      eligibleCount: eligible.length,
      learnedCount: eligible.filter((item) => firstSeenDate(state.records[item.id]) !== null).length,
      stableCount: eligible.filter((item) => status.get(item.id).stable).length,
      reviewDueCount: reviewCandidates.length,
      quizPendingCount: quizCandidates.length,
      newStartedToday,
    },
  };
}

function plainObject(value, context) {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value), `${context}格式不正确。`);
  insist(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, `${context}包含不支持的对象。`);
}

function exactKeys(object, required, context, optional = []) {
  plainObject(object, context);
  const keys = Object.keys(object);
  insist(required.every((key) => Object.hasOwn(object, key)) && keys.every((key) => required.includes(key) || optional.includes(key)), `${context}字段不正确。`);
}

function integerBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateEventIdentity(event) {
  if (event.id !== undefined) insist(typeof event.id === 'string' && /^[A-Za-z0-9:%._-]{1,700}$/.test(event.id), '记录编号不合法。');
  if (event.at !== undefined) insist(typeof event.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at) && Number.isFinite(Date.parse(event.at)) && new Date(event.at).toISOString() === event.at, '记录时间不合法。');
}

function validateState(state, knownIds) {
  exactKeys(state, ['version', 'settings', 'records', 'sessions'], '备份');
  insist(state.version === 1, '不支持这个备份版本。');
  exactKeys(state.settings, ['minutes', 'teacherOrder', 'newLimit', 'includeRecognition'], '学习设置');
  insist(integerBetween(state.settings.minutes, 5, 60), '每日学习时间必须是 5～60 分钟。');
  insist(integerBetween(state.settings.teacherOrder, 0, 1000), '老师教学进度不合法。');
  insist(integerBetween(state.settings.newLimit, 0, 20), '每日新内容数量必须是 0～20。');
  insist(typeof state.settings.includeRecognition === 'boolean', '认读设置不合法。');
  plainObject(state.records, '学习记录');
  const entries = Object.entries(state.records);
  insist(entries.length <= 2000, '学习记录数量超过允许范围。');
  const known = knownIds === undefined ? null : new Set(knownIds);
  for (const [id, record] of entries) {
    insist(validItemId(id) && (!known || known.has(id)), `备份含有不属于本册课程的内容：${String(id).slice(0, 40)}`);
    exactKeys(record, ['studiedDates', 'attempts'], '单项学习记录');
    insist(Array.isArray(record.studiedDates) && record.studiedDates.length <= 3660, '学习日期列表不合法。');
    let previous = null;
    for (const date of record.studiedDates) {
      requireDate(date);
      insist(!previous || date > previous, '学习日期必须按时间排列且不能重复。');
      previous = date;
    }
    insist(Array.isArray(record.attempts) && record.attempts.length <= 20_000, '小测记录列表不合法。');
    previous = null;
    for (const attempt of record.attempts) {
      exactKeys(attempt, ['date', 'result', 'mode'], '小测记录', ['reason', 'id', 'at']);
      validateEventIdentity(attempt);
      requireDate(attempt.date);
      insist(!previous || attempt.date >= previous, '小测日期必须按时间排列。');
      insist(RESULTS.has(attempt.result) && MODES.has(attempt.mode), '小测结果或类型不合法。');
      insist(!Object.hasOwn(attempt, 'reason') || ERROR_REASONS.has(attempt.reason), '错误原因不合法。');
      previous = attempt.date;
    }
  }
  insist(Array.isArray(state.sessions) && state.sessions.length <= 3660, '学习时长列表不合法。');
  for (const session of state.sessions) {
    exactKeys(session, ['date', 'minutes'], '学习时长记录', ['id', 'at']);
    validateEventIdentity(session);
    requireDate(session.date);
    insist(typeof session.minutes === 'number' && Number.isFinite(session.minutes) && session.minutes >= 0 && session.minutes <= 1440, '学习时长不合法。');
  }
  return state;
}

export function exportState(state) {
  validateState(state);
  return JSON.stringify({ app: APP_ID, formatVersion: 1, exportedAt: new Date().toISOString(), state }, null, 2);
}

/** Strict import accepts both this app's backup envelope and its local-storage state. */
export function importState(json, knownIds) {
  insist(typeof json === 'string' && json.length <= 2_000_000, '备份文件为空或超过 2 MB。');
  let parsed;
  try {
    parsed = JSON.parse(json, (key, value) => {
      insist(!FORBIDDEN_KEYS.has(key), '备份包含不安全字段。');
      return value;
    });
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? '备份不是有效 JSON，请选择本平台导出的备份。' : error.message);
  }
  plainObject(parsed, '备份');
  if (Object.hasOwn(parsed, 'app')) {
    exactKeys(parsed, ['app', 'formatVersion', 'exportedAt', 'state'], '备份文件');
    insist(parsed.app === APP_ID && parsed.formatVersion === 1, '这不是本语文平台支持的备份。');
    insist(typeof parsed.exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.exportedAt), '备份导出时间不合法。');
    const exported = new Date(parsed.exportedAt);
    insist(Number.isFinite(exported.getTime()) && exported.toISOString() === parsed.exportedAt, '备份导出时间不合法。');
    parsed = parsed.state;
  }
  return validateState(parsed, knownIds);
}
