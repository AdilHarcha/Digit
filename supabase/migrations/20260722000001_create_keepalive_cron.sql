-- Keep-alive : empêche la mise en pause automatique du projet Supabase (free tier)
-- Un simple SELECT toutes les 24h suffit à marquer le projet comme actif
select cron.schedule(
  'keepalive-daily',
  '0 8 * * *',  -- chaque jour à 8h UTC
  $$ select 1 $$
);
