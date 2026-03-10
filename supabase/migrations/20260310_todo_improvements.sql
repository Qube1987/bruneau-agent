-- Todo improvements migration
-- Run this in Supabase SQL Editor

-- Phase 2.5: Checklist (sub-tasks as JSONB array)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist jsonb DEFAULT '[]';

-- Phase 2.6: Recurring tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence text DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_source_id uuid DEFAULT NULL;

-- Phase 3.4: Task notes
CREATE TABLE IF NOT EXISTS task_notes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task_id ON task_notes(task_id);

-- Phase 3.2: Enable Realtime on tasks table
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;

-- Phase 4.1: My Day feature
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS my_day_date date DEFAULT NULL;

-- Phase 4.4: Manual ordering
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position integer DEFAULT NULL;
