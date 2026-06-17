-- Activer les extensions nécessaires
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Planifier le cron toutes les minutes
SELECT cron.schedule(
  'sync-notion-to-qualiobee',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ehorpbaktpkciwpigevg.supabase.co/functions/v1/sync-notion-to-qualiobee',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
