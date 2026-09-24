-- ============================================================================
-- SECURITY: COURSES project (English+ B1–B2, B2–C1, Workplace EQ)
-- Supabase project: ovosqztjtnvasbaursnh
--
-- Before: anyone with the public website key could read every student's
-- answers and glossary, change teacher marks, and delete everything.
-- After:
--   * Students can still save answers, and load/save/remove their OWN glossary
--     and progress, but only through functions that need their exact class
--     code + name. Nobody can list, dump or wipe the tables.
--   * The teacher dashboard (you, signed in) can read, mark and delete.
--
-- BEFORE RUNNING: create your teacher login (Authentication → Users → Add user
-- → Create new user, email kris@englishvoiced.com, a strong password, tick
-- "Auto Confirm User"), and turn off public sign-ups (Authentication → Sign In
-- / Providers → "Allow new users to sign up" OFF). If you use a different
-- email, change it in private.is_teacher() below.
--
-- Run the whole file once in the SQL Editor. Safe to run again.
-- ============================================================================

-- ── Who is the teacher? ─────────────────────────────────────────────────────
create schema if not exists private;
create or replace function private.is_teacher()
returns boolean language sql stable as $$
  select coalesce(lower(auth.jwt() ->> 'email') in ('kris@englishvoiced.com'), false)
$$;
grant usage on schema private to anon, authenticated;
grant execute on function private.is_teacher() to anon, authenticated;

-- ── Remove the old "anyone can do anything" rules ───────────────────────────
drop policy if exists "anon can read glossary"     on glossary;
drop policy if exists "anon can insert glossary"   on glossary;
drop policy if exists "anon can update glossary"   on glossary;
drop policy if exists "anon can delete glossary"   on glossary;
drop policy if exists "anon can read groups"       on groups;
drop policy if exists "anon can insert groups"     on groups;
drop policy if exists "anon can read progress"     on lesson_progress;
drop policy if exists "anon can insert progress"   on lesson_progress;
drop policy if exists "anon can update progress"   on lesson_progress;
drop policy if exists "anon can delete progress"   on lesson_progress;
-- (and this script's own policies, so it can be re-run)
drop policy if exists "students add answers"       on lesson_progress;
drop policy if exists "teacher reads progress"     on lesson_progress;
drop policy if exists "teacher marks progress"     on lesson_progress;
drop policy if exists "teacher deletes progress"   on lesson_progress;
drop policy if exists "teacher manages glossary"   on glossary;
drop policy if exists "teacher manages groups"     on groups;

revoke all on glossary, groups, lesson_progress from anon, authenticated;

alter table glossary        enable row level security;
alter table groups          enable row level security;
alter table lesson_progress enable row level security;

-- ── lesson_progress: students add answers; only the teacher reads/marks/deletes
grant insert on lesson_progress to anon, authenticated;
create policy "students add answers" on lesson_progress for insert to anon, authenticated
  with check (override_correct is null and teacher_verdict is null);

grant select, update, delete on lesson_progress to authenticated;
create policy "teacher reads progress"   on lesson_progress for select to authenticated using (private.is_teacher());
create policy "teacher marks progress"   on lesson_progress for update to authenticated using (private.is_teacher()) with check (private.is_teacher());
create policy "teacher deletes progress" on lesson_progress for delete to authenticated using (private.is_teacher());

-- ── glossary + groups: teacher only (students use the functions below) ──────
grant select, insert, update, delete on glossary, groups to authenticated;
create policy "teacher manages glossary" on glossary for all to authenticated using (private.is_teacher()) with check (private.is_teacher());
create policy "teacher manages groups"   on groups   for all to authenticated using (private.is_teacher()) with check (private.is_teacher());

-- ── Student functions: always need the exact class code + name ──────────────
create or replace function private.check_student(p_group text, p_name text)
returns void language plpgsql immutable as $$
begin
  if p_group is null or btrim(p_group) = '' or char_length(p_group) > 64
     or p_name is null or btrim(p_name) = '' or char_length(p_name) > 60 then
    raise exception 'invalid class code or name';
  end if;
end $$;

create or replace function public.join_group(p_group text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform private.check_student(p_group, p_name);
  insert into groups (group_id, group_name, student_names)
  values (p_group, p_group, array[p_name])
  on conflict (group_id) do update
    set student_names = case when p_name = any(coalesce(groups.student_names, '{}'))
                             then groups.student_names
                             else coalesce(groups.student_names, '{}') || p_name end;
end $$;

create or replace function public.my_progress(p_group text, p_name text, p_lesson text)
returns setof lesson_progress language plpgsql stable security definer set search_path = public as $$
begin
  perform private.check_student(p_group, p_name);
  return query select * from lesson_progress
    where group_id = p_group and student_name = p_name and lesson_id = p_lesson;
end $$;

create or replace function public.my_glossary(p_group text, p_name text)
returns setof glossary language plpgsql stable security definer set search_path = public as $$
begin
  perform private.check_student(p_group, p_name);
  return query select * from glossary where group_id = p_group and student_name = p_name;
end $$;

create or replace function public.save_glossary_word(
  p_group text, p_name text, p_key text, p_word text,
  p_ipa text default null, p_meaning text default null, p_example text default null, p_lesson text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform private.check_student(p_group, p_name);
  if p_key is null or btrim(p_key) = '' or char_length(p_key) > 120 or char_length(coalesce(p_word, '')) > 200 then
    raise exception 'invalid word';
  end if;
  perform public.join_group(p_group, p_name);   -- glossary rows need the group to exist
  insert into glossary (group_id, student_name, word_key, word, ipa, meaning, example, lesson_id)
  values (p_group, p_name, p_key, p_word, left(p_ipa, 200), left(p_meaning, 1000), left(p_example, 1000), left(p_lesson, 120))
  on conflict (group_id, student_name, word_key) do update
    set word = excluded.word, ipa = excluded.ipa, meaning = excluded.meaning,
        example = excluded.example, lesson_id = excluded.lesson_id;
end $$;

create or replace function public.remove_glossary_word(p_group text, p_name text, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform private.check_student(p_group, p_name);
  delete from glossary where group_id = p_group and student_name = p_name and word_key = p_key;
end $$;

revoke all on function public.join_group(text, text),
                       public.my_progress(text, text, text),
                       public.my_glossary(text, text),
                       public.save_glossary_word(text, text, text, text, text, text, text, text),
                       public.remove_glossary_word(text, text, text) from public;
grant execute on function public.join_group(text, text),
                          public.my_progress(text, text, text),
                          public.my_glossary(text, text),
                          public.save_glossary_word(text, text, text, text, text, text, text, text),
                          public.remove_glossary_word(text, text, text) to anon, authenticated;
revoke all on function private.check_student(text, text) from public;
grant execute on function private.check_student(text, text) to anon, authenticated;
