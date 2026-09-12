ALTER TABLE resources
  ADD COLUMN link_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN link_checked_at timestamptz;