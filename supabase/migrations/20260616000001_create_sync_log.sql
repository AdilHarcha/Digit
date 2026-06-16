CREATE TABLE IF NOT EXISTS qualiobee_sync_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  notion_page_id TEXT NOT NULL,
  session_name TEXT,
  formation_type TEXT,
  qualiobee_session_uuid TEXT,
  client_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  error_message TEXT
);

ALTER TABLE qualiobee_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only" ON qualiobee_sync_log
  USING (false);
