import { readFile,writeFile } from 'node:fs/promises';
import { flattenCurriculum } from '../public/assets/learning-engine.js';
const curriculum=JSON.parse(await readFile(new URL('../public/data/curriculum.json',import.meta.url),'utf8'));
const practices=JSON.parse(await readFile(new URL('../public/data/practices.json',import.meta.url),'utf8'));
for(const exercise of practices.exercises)curriculum.lessons.find(lesson=>lesson.id===exercise.lessonId).pinyin.push(exercise);
const ids=flattenCurriculum(curriculum).map(item=>item.id);
const sql="-- Public syllabus identifiers only. Run after 001_ziya_progress.sql.\ninsert into public.ziya_curriculum_items(id) values\n"+ids.map(id=>"('"+id.replaceAll("'","''")+"')").join(',\n')+"\non conflict(id) do nothing;\n";
await writeFile(new URL('../supabase/002_ziya_curriculum.sql',import.meta.url),sql);
console.log(`Prepared ${ids.length} Ziya curriculum identifiers.`);
