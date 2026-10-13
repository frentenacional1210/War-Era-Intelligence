-- Indexed country reports avoid repeated scans of the growing article archive.
CREATE INDEX IF NOT EXISTS idx_articles_country_published ON articles(country_id,published_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_events_country_time ON events(country_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_battles_country_active ON battles(country_id,is_active);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country_id,id);
