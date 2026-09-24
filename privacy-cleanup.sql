-- ============================================================================
-- Automatic data cleanup: COURSES project (English+ B1–B2, B2–C1, Workplace EQ)
-- Supabase project: ovosqztjtnvasbaursnh
--
-- Keeps the promise in englishvoiced.com/privacy/: course progress and glossary
-- are deleted within 12 months of a student's last activity.
--
-- A "student" is a (group_id, student_name) pair. Their last activity is the
-- newest created_at across lesson_progress and glossary. When that is more than
-- 12 months ago, ALL their rows go, and their name is removed from the group.
-- Groups left with no students are deleted too.
--
-- HOW TO USE (Supabase dashboard → this project → SQL Editor → New query):
--   STEP 1  Run the PREVIEW block alone. It only reads, and shows who would be removed.
--   STEP 2  Run the INSTALL block once. It creates the cleanup and schedules it
--           every Sunday at 03:00 UTC.
--   Later   See what each run deleted:  select * from private.cleanup_log order by ran_at desc;
--           Run it by hand:             select private.cleanup_old_data();
--           Stop the schedule:          select cron.unschedule('privacy-cleanup');
-- ============================================================================


-- ─── STEP 1: PREVIEW (read-only) ────────────────────────────────────────────
with activity as (
  select group_id, student_name, max(created_at) as last_active
  from (
    select group_id, student_name, created_at from lesson_progress
    union all
    select group_id, student_name, created_at from glossary
  ) a
  group by group_id, student_name
)
select group_id, student_name, last_active,
       case when last_active < now() - interval '12 months' then 'WOULD BE DELETED' else 'kept' end as result
from activity
order by last_active;


-- ─── STEP 2: INSTALL (run once) ─────────────────────────────────────────────
-- A schema the website's public API can't reach, so visitors can never call this.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.cleanup_log (
  ran_at        timestamptz not null default now(),
  students      int not null,
  progress_rows int not null,
  glossary_rows int not null,
  groups_removed int not null
);

create or replace function private.cleanup_old_data()
returns text
language plpgsql
as $$
declare
  cutoff constant timestamptz := now() - interval '12 months';
  n_students int; n_progress int; n_glossary int; n_groups int;
begin
  -- Students whose newest activity is older than the cutoff
  create temp table _stale on commit drop as
  select group_id, student_name
  from (
    select group_id, student_name, created_at from lesson_progress
    union all
    select group_id, student_name, created_at from glossary
  ) a
  group by group_id, student_name
  having max(created_at) < cutoff;

  select count(*) into n_students from _stale;

  delete from lesson_progress p using _stale s
   where p.group_id = s.group_id and p.student_name = s.student_name;
  get diagnostics n_progress = row_count;

  delete from glossary g using _stale s
   where g.group_id = s.group_id and g.student_name = s.student_name;
  get diagnostics n_glossary = row_count;

  -- Take their names off the group lists
  update groups gr
     set student_names = (
       select coalesce(array_agg(n), '{}') from unnest(gr.student_names) n
       where not exists (select 1 from _stale s where s.group_id = gr.group_id and s.student_name = n))
   where exists (select 1 from _stale s where s.group_id = gr.group_id);

  -- Groups with nobody left and no remaining rows
  delete from groups gr
   where coalesce(cardinality(gr.student_names), 0) = 0
     and not exists (select 1 from lesson_progress p where p.group_id = gr.group_id)
     and not exists (select 1 from glossary g where g.group_id = gr.group_id);
  get diagnostics n_groups = row_count;

  insert into private.cleanup_log (students, progress_rows, glossary_rows, groups_removed)
  values (n_students, n_progress, n_glossary, n_groups);

  return format('%s students removed (%s progress rows, %s glossary rows, %s empty groups)',
                n_students, n_progress, n_glossary, n_groups);
end;
$$;

revoke all on function private.cleanup_old_data() from public, anon, authenticated;

-- The scheduler (built into Supabase). Safe to run again: it replaces the job.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('privacy-cleanup', '0 3 * * 0', $$select private.cleanup_old_data()$$);
