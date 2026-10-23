import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, createState, flattenCurriculum, getItemStatus, buildDailyPlan,
  markStudied, recordAttempt, exportState, importState, dateKey, addDays,
} from '../public/assets/learning-engine.js';

const DAY = '2026-10-23';
const ID = 'write:天';
function attempt(state, date, result = 'pass', id = ID) {
  return recordAttempt(state, id, { date, result, mode: 'quiz' });
}
function status(state, day = DAY, id = ID) { return getItemStatus(state.records[id], day); }
function makeItems(count = 20, kind = 'write', lessonOrder = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${kind}:练${index}`, kind, text: `练${index}`, lessonId: `lesson-${lessonOrder}`,
    lessonOrder, unit: '第一单元', title: '天地人', content: { text: `练${index}` },
  }));
}

test('progress is separate from the English platform and independent between states', () => {
  assert.equal(STORAGE_KEY, 'chinese-literacy-g1:progress:v1');
  const first = createState();
  const second = createState();
  first.settings.newLimit = 3;
  first.records[ID] = {};
  assert.equal(second.settings.newLimit, 6);
  assert.equal(Object.keys(second.records).length, 0);
});

test('flatten preserves textbook order, first occurrence, and separate recognition/writing skills', () => {
  const items = flattenCurriculum({ lessons: [
    { id: 'later', order: 2, title: '后来', write: [{ text: '天', pinyin: 'tiān' }, { text: '人', pinyin: 'rén' }], recognize: [], pinyin: [] },
    { id: 'first', order: 1, title: '先学', page: 8, write: [{ text: '天', pinyin: 'tiān' }], recognize: [{ text: '天', pinyin: 'tiān' }], pinyin: [{ text: 'ā', category: '单韵母' }] },
  ] });
  assert.deepEqual(items.map((item) => item.id), ['write:天', 'pinyin:ā', 'recognize:天:tiān', 'write:人']);
  assert.equal(items[0].lessonId, 'first');
  assert.equal(items[0].pinyin, 'tiān');
  assert.equal(items[0].content.pinyin, 'tiān');
  assert.equal(items[3].lessonOrder, 2);
});

test('recognition keeps different pronunciations of the same character, with NFC-normalized IDs', () => {
  const items = flattenCurriculum({ lessons: [
    { id: 'early', order: 1, title: '先学', recognize: [
      { text: '地', pinyin: 'dì' }, { text: '着', pinyin: 'zhe' },
      { text: '数', pinyin: 'shù' }, { text: '长', pinyin: 'cháng' },
    ] },
    { id: 'later', order: 2, title: '后学', recognize: [
      { text: '地', pinyin: 'de' }, { text: '着', pinyin: 'zháo' },
      { text: '数', pinyin: 'shǔ' }, { text: '长', pinyin: 'zha\u030cng' },
      { text: '长', pinyin: 'zhǎng' },
    ] },
  ] });
  assert.deepEqual(items.map((item) => item.id), [
    'recognize:地:dì', 'recognize:着:zhe', 'recognize:数:shù', 'recognize:长:cháng',
    'recognize:地:de', 'recognize:着:zháo', 'recognize:数:shǔ', 'recognize:长:zhǎng',
  ]);
  assert.equal(items.at(-1).content.pinyin, 'zhǎng');
  assert.equal(items.at(-1).lessonId, 'later');
  const state = attempt(createState(), DAY, 'pass', 'recognize:地:dì');
  assert.equal(status(state, DAY, 'recognize:地:dì').stage, 1);
  assert.equal(status(state, DAY, 'recognize:地:de').stage, 0);
  assert.deepEqual(importState(exportState(state), items.map((item) => item.id)), state);
});

test('learning or revealing a study card never produces mastery', () => {
  const old = createState();
  const studied = markStudied(old, ID, DAY);
  assert.equal(old.records[ID], undefined);
  assert.equal(status(studied).stage, 0);
  assert.equal(status(studied).stable, false);
  assert.equal(status(studied).needsQuiz, true);
  assert.equal(markStudied(studied, ID, DAY), studied);
});

test('same-day correct repetitions cannot inflate a stage or move the due date', () => {
  let state = attempt(createState(), DAY);
  const first = state;
  state = attempt(state, DAY);
  state = attempt(state, DAY);
  assert.equal(status(state).stage, 1);
  assert.equal(status(state).dueDate, '2026-10-24');
  assert.equal(first.records[ID].attempts.length, 1);
  assert.equal(state.records[ID].attempts.length, 3);
});

test('hint then pass, or fail then pass, cannot advance on the same date', () => {
  for (const result of ['hint', 'fail']) {
    let state = attempt(createState(), DAY, result);
    state = attempt(state, DAY);
    assert.equal(status(state).stage, 0);
    assert.equal(status(state).dueDate, '2026-10-24');
    state = attempt(state, '2026-10-24');
    assert.equal(status(state, '2026-10-24').stage, 1);
  }
});

test('a later same-day failure revokes a prior pass', () => {
  let state = attempt(createState(), DAY);
  state = attempt(state, DAY, 'fail');
  assert.equal(status(state).stage, 0);
  assert.equal(status(state).stable, false);
});

test('stable mastery requires independent dates and the final seven-day delay', () => {
  let state = createState();
  for (const [day, expected] of [['2026-10-23', 1], ['2026-10-24', 2], ['2026-10-27', 3], ['2026-11-03', 4]]) {
    state = attempt(state, day);
    assert.equal(status(state, day).stage, expected);
    assert.equal(status(state, day).stable, expected === 4);
  }
  assert.equal(status(state, '2026-11-03').dueDate, '2026-11-17');
  state = attempt(state, '2026-11-17');
  assert.equal(status(state, '2026-11-17').stage, 4);
  assert.equal(status(state, '2026-11-17').dueDate, '2026-12-01');
});

test('testing early cannot skip a scheduled delay', () => {
  let state = attempt(createState(), '2026-10-23');
  state = attempt(state, '2026-10-24');
  state = attempt(state, '2026-10-25');
  state = attempt(state, '2026-10-26');
  assert.equal(status(state, '2026-10-26').stage, 2);
  assert.equal(status(state, '2026-10-26').dueDate, '2026-10-27');
});

test('missed days do not fabricate success; late success starts its next actual delay', () => {
  let state = attempt(createState(), '2026-10-23');
  assert.equal(status(state, '2026-11-10').stage, 1);
  assert.equal(status(state, '2026-11-10').isDue, true);
  state = attempt(state, '2026-11-10');
  assert.equal(status(state, '2026-11-10').stage, 2);
  assert.equal(status(state, '2026-11-10').dueDate, '2026-11-13');
});

test('failure after stable mastery restarts verification and schedules tomorrow', () => {
  let state = createState();
  for (const day of ['2026-10-23', '2026-10-24', '2026-10-27', '2026-11-03']) state = attempt(state, day);
  state = attempt(state, '2026-11-17', 'hint');
  assert.equal(status(state, '2026-11-17').stage, 0);
  assert.equal(status(state, '2026-11-17').stable, false);
  assert.equal(status(state, '2026-11-17').dueDate, '2026-11-18');
});

test('relearning a tested card invalidates delayed recall even without a new quiz', () => {
  let state = createState();
  for (const day of ['2026-10-23', '2026-10-24', '2026-10-27', '2026-11-03']) state = attempt(state, day);
  assert.equal(status(state, '2026-11-04').stable, true);
  state = markStudied(state, ID, '2026-11-04');
  assert.equal(status(state, '2026-11-04').stage, 0);
  assert.equal(status(state, '2026-11-04').stable, false);
  assert.equal(status(state, '2026-11-04').dueDate, '2026-11-05');
  assert.equal(status(state, '2026-11-04').relearnedToday, true);
  assert.equal(status(state, '2026-11-05').isDue, true);
  assert.equal(state.records[ID].attempts.length, 4, 'relearning must not fabricate a hint/fail quiz');
  state = attempt(state, '2026-11-04');
  assert.equal(status(state, '2026-11-04').stage, 0);
  state = attempt(state, '2026-11-05');
  assert.equal(status(state, '2026-11-05').stage, 1);
});

test('same-day first learning allows initial recall, while later study-first review cannot advance', () => {
  let state = markStudied(createState(), ID, DAY);
  state = attempt(state, DAY);
  assert.equal(status(state).stage, 1);
  state = markStudied(state, ID, '2026-10-24');
  state = attempt(state, '2026-10-24');
  state = attempt(state, '2026-10-24');
  assert.equal(status(state, '2026-10-24').stage, 0);
  assert.equal(status(state, '2026-10-24').dueDate, '2026-10-25');
  assert.deepEqual(importState(exportState(state), [ID]), state);
  assert.equal(status(importState(exportState(state), [ID]), '2026-10-24').stage, 0);
});

test('reopening a previously tested card after passing today conservatively revokes today’s delayed pass', () => {
  let state = attempt(createState(), DAY);
  state = attempt(state, '2026-10-24');
  assert.equal(status(state, '2026-10-24').stage, 2);
  state = markStudied(state, ID, '2026-10-24');
  assert.equal(status(state, '2026-10-24').stage, 0);
  assert.equal(status(state, '2026-10-24').dueDate, '2026-10-25');
  assert.equal(status(state, DAY).stage, 1, 'future studying must not change an earlier day’s status');
});

test('daily work follows lesson order and stops at the teacher boundary', () => {
  const items = [...makeItems(2, 'write', 2).map((item) => ({ ...item, id: `${item.id}后` })), ...makeItems(2), ...makeItems(1, 'recognize')];
  const state = createState();
  const plan = buildDailyPlan(items, state, DAY);
  assert.deepEqual(plan.newItems.map((item) => item.lessonOrder), [1, 1]);
  assert.equal(plan.recognition.length, 0);
  assert.equal(plan.summary.eligibleCount, 2);
  state.settings.teacherOrder = 0;
  assert.equal(buildDailyPlan(items, state, DAY).newItems.length, 0);
});

test('optional recognition has its own daily slot and record', () => {
  const items = [...makeItems(10), ...makeItems(10, 'recognize')];
  const state = createState();
  state.settings.includeRecognition = true;
  const plan = buildDailyPlan(items, state, DAY);
  assert.equal(plan.newItems.length, 5);
  assert.equal(plan.recognition.length, 1);
  assert.ok(plan.totalEstimatedMinutes <= 20);
});

test('marking a new item studied creates a quiz without continually adding more new work', () => {
  const items = makeItems(20);
  let state = createState();
  const initial = buildDailyPlan(items, state, DAY);
  assert.equal(initial.newItems.length, 6);
  for (const item of initial.newItems) state = markStudied(state, item.id, DAY);
  let plan = buildDailyPlan(items, state, DAY);
  assert.equal(plan.newItems.length, 0);
  assert.equal(plan.quiz.length, 6);
  assert.equal(plan.completedMinutes, 9);
  assert.equal(plan.totalEstimatedMinutes, 18);
  for (const item of plan.quiz) state = attempt(state, DAY, 'pass', item.id);
  plan = buildDailyPlan(items, state, DAY);
  assert.equal(plan.newItems.length, 0);
  assert.equal(plan.quiz.length, 0);
  assert.equal(plan.completedMinutes, 18);
  assert.equal(plan.summary.stableCount, 0);
});

test('reviews are oldest due first and capped, with honest overflow', () => {
  const items = makeItems(20);
  let state = createState();
  for (let index = 0; index < 12; index += 1) state = attempt(state, index === 11 ? '2026-10-20' : '2026-10-21', 'pass', items[index].id);
  const plan = buildDailyPlan(items, state, DAY);
  assert.equal(plan.review.length, 6);
  assert.equal(plan.review[0].id, items[11].id);
  assert.equal(plan.overflowReviewCount, 6);
  assert.ok(plan.totalEstimatedMinutes <= 20);
  for (const item of plan.review) state = attempt(state, DAY, 'pass', item.id);
  const rebuilt = buildDailyPlan(items, state, DAY);
  assert.ok(rebuilt.totalEstimatedMinutes <= 20);
});

test('a failed item waits until tomorrow rather than appearing as a mastered or immediate-repeat task', () => {
  const items = makeItems(2);
  const state = attempt(createState(), DAY, 'fail', items[0].id);
  const today = buildDailyPlan(items, state, DAY);
  assert.ok(!today.review.some((item) => item.id === items[0].id));
  assert.ok(!today.newItems.some((item) => item.id === items[0].id));
  const tomorrow = buildDailyPlan(items, state, addDays(DAY, 1));
  assert.equal(tomorrow.review[0].id, items[0].id);
});

test('round-trip backup retains history and accepts local-storage state', () => {
  let state = markStudied(createState(), ID, DAY);
  state = attempt(state, DAY);
  assert.deepEqual(importState(exportState(state), [ID]), state);
  assert.deepEqual(importState(JSON.stringify(state), new Set([ID])), state);
});

test('optional error reasons round-trip, while blank reasons preserve the old record shape', () => {
  for (const reason of ['字形/笔画', '读音/声调', '拼写顺序', '暂时想不起来']) {
    const state = recordAttempt(createState(), ID, { date: DAY, result: 'fail', mode: 'quiz', reason });
    assert.equal(state.records[ID].attempts[0].reason, reason);
    assert.deepEqual(importState(exportState(state), [ID]), state);
  }
  for (const reason of [undefined, '']) {
    const state = recordAttempt(createState(), ID, { date: DAY, result: 'hint', reason });
    assert.deepEqual(state.records[ID].attempts[0], { date: DAY, result: 'hint', mode: 'quiz' });
    assert.deepEqual(importState(exportState(state), [ID]), state);
  }
});

test('unknown error reasons and extra attempt fields are rejected on recording and import', () => {
  for (const reason of ['不够努力', '<script>', null, 12, {}, []]) {
    assert.throws(() => recordAttempt(createState(), ID, { date: DAY, result: 'fail', reason }), /原因/);
    const state = attempt(createState(), DAY, 'fail');
    state.records[ID].attempts[0].reason = reason;
    assert.throws(() => importState(JSON.stringify(state), [ID]), /原因/);
  }
  const extra = attempt(createState(), DAY, 'fail');
  extra.records[ID].attempts[0].comment = 'extra';
  assert.throws(() => importState(JSON.stringify(extra), [ID]), /字段/);
});

test('imports reject prototype pollution at any depth without mutating builtins', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const json = JSON.stringify(createState()).replace('"records":{}', `"records":{"${key}":{"polluted":true}}`);
    assert.throws(() => importState(json, [ID]), /不安全/);
  }
  assert.equal({}.polluted, undefined);
});

test('imports reject malformed dates, impossible timestamps, wrong apps, forged stages, and unknown content', () => {
  const valid = attempt(createState(), DAY);
  const badDate = structuredClone(valid);
  badDate.records[ID].attempts[0].date = '2026-02-29';
  assert.throws(() => importState(JSON.stringify(badDate), [ID]), /日期/);
  const forged = structuredClone(valid);
  forged.records[ID].stage = 4;
  assert.throws(() => importState(JSON.stringify(forged), [ID]), /字段/);
  assert.throws(() => importState(JSON.stringify(valid), []), /不属于/);
  const envelope = JSON.parse(exportState(valid));
  envelope.app = 'english-coach';
  assert.throws(() => importState(JSON.stringify(envelope), [ID]), /语文平台/);
  envelope.app = 'chinese-literacy-g1';
  envelope.exportedAt = '2026-02-30T00:00:00.000Z';
  assert.throws(() => importState(JSON.stringify(envelope), [ID]), /时间/);
});

test('imports reject corrupted fields, duplicate study dates, backward attempts, and excessive files', () => {
  const state = markStudied(createState(), ID, DAY);
  const duplicate = structuredClone(state);
  duplicate.records[ID].studiedDates.push(DAY);
  assert.throws(() => importState(JSON.stringify(duplicate), [ID]), /重复/);
  const backward = structuredClone(state);
  backward.records[ID].attempts = [{ date: DAY, result: 'pass', mode: 'quiz' }, { date: '2026-10-22', result: 'pass', mode: 'quiz' }];
  assert.throws(() => importState(JSON.stringify(backward), [ID]), /时间排列/);
  const settings = structuredClone(state);
  settings.settings.minutes = '20';
  assert.throws(() => importState(JSON.stringify(settings), [ID]), /分钟/);
  assert.throws(() => importState('{broken'), /JSON/);
  assert.throws(() => importState(' '.repeat(2_000_001)), /2 MB/);
  assert.throws(() => importState('null'), /格式/);
});

test('calendar arithmetic handles month/year boundaries and rejects invalid dates or backward recording', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(dateKey(new Date(2026, 9, 23, 0, 0)), DAY);
  assert.throws(() => addDays('2026-02-29', 1), /日期/);
  assert.throws(() => dateKey(new Date('invalid')), /有效日期/);
  const state = attempt(createState(), DAY);
  assert.throws(() => attempt(state, '2026-10-22'), /设备日期/);
  assert.throws(() => markStudied(state, ID, '2026-10-22'), /设备日期/);
});
