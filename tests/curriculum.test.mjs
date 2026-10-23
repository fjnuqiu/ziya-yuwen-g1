import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenCurriculum } from '../public/assets/learning-engine.js';

const read = async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`,import.meta.url),'utf8'));
const book = await read('curriculum');
const practice = await read('practices');
const strokes = await read('strokes');
const references = await read('references');
const letters = book.lessons.flatMap(l=>l.pinyin);

test('current edition covers all 40 ordered lessons including all eight language gardens',()=>{
  assert.equal(book.lessons.length,40);
  assert.deepEqual(book.lessons.map(l=>l.order),Array.from({length:40},(_,i)=>i+1));
  assert.equal(new Set(book.lessons.map(l=>l.id)).size,40);
  assert.equal(book.lessons.filter(l=>l.title.startsWith('语文园地')).length,8);
  for(let i=1;i<40;i++)assert.ok(book.lessons[i].page>book.lessons[i-1].page);
  assert.equal(book.lessons[5].title,'1 a o e');
  assert.equal(book.lessons[14].title,'9 y w');
  assert.equal(book.lessons[34].title,'7 两件宝');
  assert.equal(book.lessons[39].title,'语文园地八');
});

test('official recognition and writing inventories are complete without conflating skills',()=>{
  const recognized=book.lessons.flatMap(l=>l.recognize),written=book.lessons.flatMap(l=>l.write);
  assert.equal(recognized.length,284);
  assert.equal(new Set(recognized.map(c=>c.text)).size,280);
  assert.equal(written.length,100);
  assert.equal(new Set(written.map(c=>c.text)).size,100);
  assert.ok(written.every(w=>recognized.some(r=>r.text===w.text)));
  assert.ok(recognized.every(c=>c.pinyin && !/[A-Z?\ufffd]/u.test(c.pinyin)));
  assert.equal(flattenCurriculum(book).filter(i=>i.kind==='recognize').length,284);
});

test('live publisher corrections are protected against older PDF substitutions',()=>{
  const writes=id=>book.lessons.find(l=>l.id===id).write.map(c=>c.text).join('');
  assert.equal(writes('u4-l6'),'个去');
  assert.equal(writes('u8-l2'),'只多办石出');
  assert.equal(writes('u8-l4'),'牛羊爪白');
  assert.ok(book.lessons.at(-1).recognize.some(c=>c.text==='元'&&c.pinyin==='yuán'));
});

test('all 23 initials, 24 finals and 16 whole syllables are represented exactly once',()=>{
  const expected='b p m f d t n l g k h j q x zh ch sh r z c s y w a o e i u ü ai ei ui ao ou iu ie üe er an en in un ün ang eng ing ong zhi chi shi ri zi ci si yi wu yu ye yue yuan yin yun ying'.split(' ');
  assert.equal(letters.length,63);
  assert.deepEqual(letters.map(c=>c.text).sort(),expected.sort());
  assert.deepEqual(letters.find(c=>c.text==='er').toneForms,['ér','ěr','èr']);
});

test('polyphonic forms retain matching context and separate progress IDs',()=>{
  const all=flattenCurriculum(book);
  for(const [text,readings] of [['地',['dì','de']],['着',['zhe','zháo']],['数',['shù','shǔ']],['长',['cháng','zhǎng']]]){
    const variants=all.filter(i=>i.kind==='recognize'&&i.text===text);
    assert.deepEqual(variants.map(v=>v.pinyin).sort(),readings.sort());
    assert.ok(variants.every(v=>v.content.word&&v.content.wordPinyin));
    assert.equal(new Set(variants.map(v=>v.id)).size,2);
  }
});

test('self-authored tone and blending practice stays attached to the correct lesson',()=>{
  assert.equal(practice.exercises.length,66);
  assert.ok(practice.exercises.every(e=>book.lessons.some(l=>l.id===e.lessonId && l.pinyin.length)));
  assert.equal(practice.exercises.filter(e=>e.category.startsWith('声调')).length,24);
  assert.equal(practice.exercises.find(e=>e.text==='jū').lessonId,'u3-l2');
  assert.equal(practice.exercises.find(e=>e.text==='niú').lessonId,'u4-l2');
  const merged=structuredClone(book);
  for(const e of practice.exercises)merged.lessons.find(l=>l.id===e.lessonId).pinyin.push(e);
  assert.equal(flattenCurriculum(merged).length,513);
});

test('all 100 writing characters have real offline stroke geometry',()=>{
  const chars=book.lessons.flatMap(l=>l.write).map(c=>c.text);
  assert.equal(Object.keys(strokes).length,100);
  for(const char of chars){assert.ok(strokes[char]?.strokes?.length);assert.equal(strokes[char].strokes.length,strokes[char].medians.length);}
});

test('appendix references are complete and kept out of required dictation inventory',()=>{
  assert.equal(references.strokes.length,32);
  assert.equal(references.radicals.length,29);
  assert.ok(references.strokes.every(s=>s.symbol&&s.name));
  assert.ok(references.radicals.every(s=>s.symbol&&s.name));
  assert.deepEqual(references.sourcePages,[109,110]);
});
