-- Apply only to the dedicated Ziya Supabase project. Contains no child records.
begin;

create table if not exists public.ziya_curriculum_items (id text primary key);
create table if not exists public.ziya_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.ziya_sync_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.ziya_progress enable row level security;
alter table public.ziya_progress force row level security;
alter table public.ziya_sync_receipts enable row level security;
alter table public.ziya_sync_receipts force row level security;
alter table public.ziya_curriculum_items enable row level security;
alter table public.ziya_curriculum_items force row level security;
revoke all on public.ziya_progress, public.ziya_sync_receipts, public.ziya_curriculum_items from public, anon, authenticated;
grant select on public.ziya_progress to authenticated;
drop policy if exists ziya_read_own_progress on public.ziya_progress;
create policy ziya_read_own_progress on public.ziya_progress for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.ziya_has_keys(v jsonb, required text[], optional text[] default array[]::text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'object' and v ?& required and (v - required - optional) = '{}'::jsonb, false);
$$;

create or replace function public.ziya_valid_date(v text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  return coalesce(v ~ '^\d{4}-\d{2}-\d{2}$' and to_char(v::date,'YYYY-MM-DD') = v, false);
exception when others then return false;
end;
$$;

create or replace function public.ziya_valid_event(v jsonb, is_session boolean)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if not public.ziya_has_keys(v,case when is_session then array['id','date','minutes'] else array['id','date','result','mode'] end,
    case when is_session then array['at'] else array['at','reason'] end)
    or jsonb_typeof(v->'id') <> 'string' or length(v->>'id') > 700 or not (v->>'id' ~ '^[A-Za-z0-9:%._-]+$')
    or jsonb_typeof(v->'date') <> 'string' or not public.ziya_valid_date(v->>'date') then return false; end if;
  if v ? 'at' and (jsonb_typeof(v->'at') <> 'string'
    or not (v->>'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    or to_char((v->>'at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v->>'at') then return false; end if;
  if is_session then
    return jsonb_typeof(v->'minutes') = 'number' and (v->>'minutes')::numeric between 0 and 1440;
  end if;
  return coalesce(v->>'result' in ('pass','hint','fail') and v->>'mode' in ('quiz','review')
    and (not (v ? 'reason') or v->>'reason' in ('字形/笔画','读音/声调','拼写顺序','暂时想不起来')),false);
exception when others then return false;
end;
$$;

create or replace function public.ziya_validate_state(s jsonb)
returns void language plpgsql set search_path = '' as $$
declare item record; event jsonb; day jsonb; prev text; settings jsonb; ids text[];
begin
  if s is null or octet_length(s::text) > 2000000 or not public.ziya_has_keys(s,array['version','settings','records','sessions']) or s->'version' <> '1'::jsonb then raise exception 'Invalid Ziya state'; end if;
  settings := s->'settings';
  if not public.ziya_has_keys(settings,array['minutes','teacherOrder','newLimit','includeRecognition'])
    or jsonb_typeof(settings->'includeRecognition') <> 'boolean'
    or jsonb_typeof(settings->'minutes') <> 'number' or not (settings->>'minutes' ~ '^\d+$') or (settings->>'minutes')::int not between 5 and 60
    or jsonb_typeof(settings->'teacherOrder') <> 'number' or not (settings->>'teacherOrder' ~ '^\d+$') or (settings->>'teacherOrder')::int not between 0 and 40
    or jsonb_typeof(settings->'newLimit') <> 'number' or not (settings->>'newLimit' ~ '^\d+$') or (settings->>'newLimit')::int not between 0 and 20 then raise exception 'Invalid Ziya settings'; end if;
  if jsonb_typeof(s->'records') <> 'object' or (select count(*) from jsonb_object_keys(s->'records')) > 2000
    or jsonb_typeof(s->'sessions') <> 'array' or jsonb_array_length(s->'sessions') > 3660 then raise exception 'Invalid Ziya records'; end if;
  for item in select * from jsonb_each(s->'records') loop
    if not exists(select 1 from public.ziya_curriculum_items where id = item.key) then raise exception 'Unknown Ziya curriculum item'; end if;
    if not public.ziya_has_keys(item.value,array['studiedDates','attempts'])
      or jsonb_typeof(item.value->'studiedDates') <> 'array' or jsonb_array_length(item.value->'studiedDates') > 3660
      or jsonb_typeof(item.value->'attempts') <> 'array' or jsonb_array_length(item.value->'attempts') > 20000 then raise exception 'Invalid Ziya item'; end if;
    prev := null;
    for day in select * from jsonb_array_elements(item.value->'studiedDates') loop
      if jsonb_typeof(day) <> 'string' or not public.ziya_valid_date(day #>> '{}') or (prev is not null and (day #>> '{}') <= prev) then raise exception 'Invalid study date'; end if;
      prev := day #>> '{}';
    end loop;
    prev := null; ids := array[]::text[];
    for event in select * from jsonb_array_elements(item.value->'attempts') loop
      if not public.ziya_valid_event(event,false) or event->>'id' = any(ids) or (prev is not null and event->>'date' < prev) then raise exception 'Invalid Ziya attempt'; end if;
      prev := event->>'date'; ids := array_append(ids,event->>'id');
    end loop;
  end loop;
  ids := array[]::text[];
  for event in select * from jsonb_array_elements(s->'sessions') loop
    if not public.ziya_valid_event(event,true) or event->>'id' = any(ids) then raise exception 'Invalid Ziya session'; end if;
    ids := array_append(ids,event->>'id');
  end loop;
end;
$$;

create or replace function public.ziya_commit_progress(p_account_id uuid, p_request_id text, p_expected_revision bigint, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid; existing public.ziya_progress%rowtype; item record; sessions jsonb; new_state jsonb;
begin
  owner := auth.uid();
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_account_id is distinct from owner then raise exception 'Account changed' using errcode = '42501'; end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9-]{16,80}$' or p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid request'; end if;
  -- Insertion and row lock serialize this account's CAS + receipt transaction.
  insert into public.ziya_progress(user_id,state) values(owner,'{"version":1,"settings":{"minutes":20,"teacherOrder":1,"newLimit":6,"includeRecognition":true},"records":{},"sessions":[]}') on conflict(user_id) do nothing;
  select * into existing from public.ziya_progress where user_id = owner for update;
  if exists(select 1 from public.ziya_sync_receipts where user_id = owner and request_id = p_request_id) then
    return jsonb_build_object('user_id',owner,'state',existing.state,'revision',existing.revision,'updated_at',existing.updated_at,'conflict',false);
  end if;
  if existing.revision <> p_expected_revision then
    return jsonb_build_object('user_id',owner,'state',existing.state,'revision',existing.revision,'updated_at',existing.updated_at,'conflict',true);
  end if;
  perform public.ziya_validate_state(p_state);
  for item in select * from jsonb_each(existing.state->'records') loop
    if not coalesce((p_state->'records'->item.key) @> item.value,false) then raise exception 'Existing learning records cannot be removed or rewritten'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(existing.state->'sessions') a cross join jsonb_array_elements(p_state->'sessions') b where a->>'id' = b->>'id' and a <> b) then raise exception 'Conflicting session'; end if;
  -- Preserve existing sessions and keep the same newest-3660 bound as the UI.
  select coalesce(jsonb_agg(e order by e->>'date',coalesce(e->>'at',''),e->>'id'),'[]'::jsonb) into sessions from (
    select e from (select distinct e from jsonb_array_elements((existing.state->'sessions') || (p_state->'sessions')) e) distinct_events
    order by e->>'date' desc,coalesce(e->>'at','') desc,e->>'id' desc limit 3660
  ) recent;
  new_state := jsonb_set(p_state,'{sessions}',sessions);
  perform public.ziya_validate_state(new_state);
  update public.ziya_progress set state = new_state, revision = revision + 1, updated_at = now() where user_id = owner returning * into existing;
  insert into public.ziya_sync_receipts(user_id,request_id) values(owner,p_request_id);
  return jsonb_build_object('user_id',owner,'state',existing.state,'revision',existing.revision,'updated_at',existing.updated_at,'conflict',false);
end;
$$;

revoke all on function public.ziya_has_keys(jsonb,text[],text[]), public.ziya_valid_date(text), public.ziya_valid_event(jsonb,boolean), public.ziya_validate_state(jsonb), public.ziya_commit_progress(uuid,text,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.ziya_commit_progress(uuid,text,bigint,jsonb) to authenticated;
commit;
