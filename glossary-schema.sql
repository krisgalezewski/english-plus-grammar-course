-- ============================================================
-- Glossary table — durable, cross-device word list per student.
-- Run once in the SQL Editor, same as the other setup files.
-- ============================================================

create table if not exists glossary (
  id bigint generated always as identity primary key,
  group_id text references groups(group_id) not null,
  student_name text not null,
  word_key text not null,
  word text not null,
  ipa text,
  meaning text,
  example text,
  lesson_id text,
  created_at timestamptz default now(),
  unique (group_id, student_name, word_key)
);

alter table glossary enable row level security;

grant select, insert, update, delete on glossary to anon;
create policy "anon can read glossary" on glossary for select using (true);
create policy "anon can insert glossary" on glossary for insert with check (true);
create policy "anon can update glossary" on glossary for update using (true);
create policy "anon can delete glossary" on glossary for delete using (true);

alter publication supabase_realtime add table glossary;
