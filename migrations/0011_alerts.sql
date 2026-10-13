-- Deterministic observations only. Do not backfill old snapshots as newly observed news.
CREATE INDEX IF NOT EXISTS idx_snapshots_previous ON entity_snapshots(entity_type,entity_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_government_snapshots_country ON entity_snapshots(json_extract(data_json,'$.countryId'),id DESC)
 WHERE entity_type='governments';
CREATE INDEX IF NOT EXISTS idx_prices_previous ON market_prices(item_id,country_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_country_time ON alerts(country_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity_time ON alerts(severity,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_theme_time ON alerts(json_extract(data_json,'$.theme'),updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_entity ON events(event_type,json_extract(data_json,'$.entityId'));

CREATE TABLE IF NOT EXISTS battle_reconciliation_state (
  battle_id TEXT PRIMARY KEY REFERENCES battles(id) ON DELETE CASCADE,
  last_checked_at TEXT NOT NULL,
  last_status TEXT NOT NULL CHECK(last_status IN ('verified-active','verified-inactive','not-found-unknown'))
);
CREATE INDEX IF NOT EXISTS idx_battle_reconciliation_due ON battle_reconciliation_state(last_checked_at,battle_id);
INSERT OR IGNORE INTO source_registry(id,endpoint,status,interval_seconds,enabled)
 VALUES('battle-reconciliation','battle.getById(known active battle)','pending',600,1);
INSERT OR IGNORE INTO ingestion_cursors(source_id,next_run_at)
 VALUES('battle-reconciliation','1970-01-01T00:00:00.000Z');

UPDATE source_registry SET status='ok',endpoint='derived:public snapshots and prices',enabled=1 WHERE id IN ('events','alerts');
UPDATE source_registry SET record_count=(SELECT COUNT(*) FROM events) WHERE id='events';
UPDATE source_registry SET record_count=(SELECT COUNT(*) FROM alerts) WHERE id='alerts';
CREATE TRIGGER IF NOT EXISTS count_events_insert AFTER INSERT ON events BEGIN UPDATE source_registry SET record_count=record_count+1,last_success=NEW.updated_at WHERE id='events'; END;
CREATE TRIGGER IF NOT EXISTS count_events_delete AFTER DELETE ON events BEGIN UPDATE source_registry SET record_count=MAX(0,record_count-1) WHERE id='events'; END;
CREATE TRIGGER IF NOT EXISTS count_alerts_insert AFTER INSERT ON alerts BEGIN UPDATE source_registry SET record_count=record_count+1,last_success=NEW.updated_at WHERE id='alerts'; END;
CREATE TRIGGER IF NOT EXISTS count_alerts_delete AFTER DELETE ON alerts BEGIN UPDATE source_registry SET record_count=MAX(0,record_count-1) WHERE id='alerts'; END;
CREATE TRIGGER IF NOT EXISTS alert_for_derived_event AFTER INSERT ON events
WHEN EXISTS(SELECT 1 FROM source_registry WHERE id='alerts' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO alerts(id,name,country_id,severity,source_url,updated_at,first_seen,hash,data_json)
  VALUES(NEW.id,NEW.name,NEW.country_id,json_extract(NEW.data_json,'$.severity'),NEW.source_url,NEW.updated_at,NEW.first_seen,NEW.hash,NEW.data_json);
END;

-- First sighting of an active battle is news, but does not imply its start time.
CREATE TRIGGER IF NOT EXISTS event_battle_observed AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='battles' AND json_extract(NEW.data_json,'$.isActive')=1
 AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1)
 AND EXISTS(SELECT 1 FROM battles b WHERE b.id=NEW.entity_id AND b.first_seen=NEW.captured_at)
 AND NOT EXISTS(SELECT 1 FROM entity_snapshots p WHERE p.entity_type='battles' AND p.entity_id=NEW.entity_id AND p.id<NEW.id)
 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.event_type='battle-observed' AND json_extract(e.data_json,'$.entityId')=NEW.entity_id)
BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  VALUES('battle-observed:'||NEW.id,'Active battle observed',
    json_extract(NEW.data_json,'$.countryId'),'battle-observed',
    COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM battles WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','military','severity','notable','entityType','battles','entityId',NEW.entity_id,
      'rule','first-active-observation','verification','public-battle-snapshot','before',NULL,
      'after',json_object('isActive',1,'attackerCountry',json_extract(NEW.data_json,'$.attackerCountry'),
        'defenderCountry',json_extract(NEW.data_json,'$.defenderCountry')),
      'explanation','An active battle appeared in the captured public feed. Its actual start may be earlier.'));
END;

-- Only an explicit inactive detail/feed record can establish a confirmed inactive state.
CREATE TRIGGER IF NOT EXISTS event_battle_finished AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='battles' AND json_extract(NEW.data_json,'$.isActive')=0
 AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1)
 AND (EXISTS(SELECT 1 FROM entity_snapshots p WHERE p.entity_type='battles' AND p.entity_id=NEW.entity_id AND p.id<NEW.id
       AND json_extract(p.data_json,'$.isActive')=1)
      OR (json_extract(NEW.data_json,'$.endedAt') IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM entity_snapshots p WHERE p.entity_type='battles' AND p.entity_id=NEW.entity_id AND p.id<NEW.id)))
 AND NOT EXISTS(SELECT 1 FROM entity_snapshots p WHERE p.entity_type='battles' AND p.entity_id=NEW.entity_id AND p.id<NEW.id
       AND json_extract(p.data_json,'$.isActive')=0)
 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.event_type='battle-inactive' AND json_extract(e.data_json,'$.entityId')=NEW.entity_id)
BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  VALUES('battle-inactive:'||NEW.id,'Battle confirmed inactive',json_extract(NEW.data_json,'$.countryId'),'battle-inactive',
    COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM battles WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','military','severity','notable','entityType','battles','entityId',NEW.entity_id,
      'rule','explicit-inactive-battle','verification','public-battle-detail-or-feed',
      'before',json_object('isActive',1),
      'after',json_object('isActive',0,'endedAt',json_extract(NEW.data_json,'$.endedAt'),'wonBy',json_extract(NEW.data_json,'$.wonBy')),
      'explanation','The public battle record explicitly reports isActive=false. This is not inferred from feed disappearance.'));
END;

CREATE TRIGGER IF NOT EXISTS event_territorial_change AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='regions' AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'region-country:'||NEW.id,'Observed region control change',json_extract(NEW.data_json,'$.countryId'),
    'region-country',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM regions WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','territory','severity','high','entityType','regions','entityId',NEW.entity_id,
      'rule','country-changed-with-known-before-after','verification','two-public-region-snapshots',
      'before',json_object('country',json_extract(p.data_json,'$.country')),
      'after',json_object('country',json_extract(NEW.data_json,'$.country')),
      'explanation','The region country differs between two captured public records. The exact transfer time is not established.')
  FROM entity_snapshots p WHERE p.id=(SELECT id FROM entity_snapshots
    WHERE entity_type='regions' AND entity_id=NEW.entity_id AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND json_extract(p.data_json,'$.country') IS NOT NULL
    AND json_extract(NEW.data_json,'$.country') IS NOT NULL
    AND json_extract(p.data_json,'$.country')<>json_extract(NEW.data_json,'$.country');
END;

CREATE TRIGGER IF NOT EXISTS event_government_leaders AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='governments' AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'government-leader:'||NEW.id,'Observed government leadership change',json_extract(NEW.data_json,'$.countryId'),
    'government-leader',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM governments WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','politics','severity','high','entityType','governments','entityId',NEW.entity_id,
      'rule','leader-changed-with-known-before-after','verification','two-public-government-snapshots',
      'before',json_object('president',json_extract(p.data_json,'$.president'),'vicePresident',json_extract(p.data_json,'$.vicePresident')),
      'after',json_object('president',json_extract(NEW.data_json,'$.president'),'vicePresident',json_extract(NEW.data_json,'$.vicePresident')),
      'explanation','A named government leader differs between captured public records. The exact appointment time is not established.')
  FROM entity_snapshots p WHERE p.id=(SELECT id FROM entity_snapshots
    WHERE entity_type='governments' AND json_extract(data_json,'$.countryId')=json_extract(NEW.data_json,'$.countryId')
      AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND ((json_extract(p.data_json,'$.president') IS NOT NULL AND json_extract(NEW.data_json,'$.president') IS NOT NULL
      AND json_extract(p.data_json,'$.president')<>json_extract(NEW.data_json,'$.president'))
      OR (json_extract(p.data_json,'$.vicePresident') IS NOT NULL AND json_extract(NEW.data_json,'$.vicePresident') IS NOT NULL
      AND json_extract(p.data_json,'$.vicePresident')<>json_extract(NEW.data_json,'$.vicePresident')));
END;

CREATE TRIGGER IF NOT EXISTS event_group_growth AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type IN ('parties','military-units')
 AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'member-growth:'||NEW.id,'Observed membership growth',json_extract(NEW.data_json,'$.countryId'),
    'member-growth',COALESCE(json_extract(NEW.data_json,'$.source_url'),
      CASE NEW.entity_type WHEN 'parties' THEN (SELECT source_url FROM parties WHERE id=NEW.entity_id)
        ELSE (SELECT source_url FROM military_units WHERE id=NEW.entity_id) END),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','community','severity','notable','entityType',NEW.entity_type,'entityId',NEW.entity_id,
      'rule','member-count-plus-20-percent-and-5','verification','two-public-aggregate-snapshots',
      'before',json_object('memberCount',json_extract(p.data_json,'$.memberCount')),
      'after',json_object('memberCount',json_extract(NEW.data_json,'$.memberCount')),
      'explanation','The reported member count rose by at least five and 20% between captured public records.')
  FROM entity_snapshots p WHERE p.id=(SELECT id FROM entity_snapshots
    WHERE entity_type=NEW.entity_type AND entity_id=NEW.entity_id AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND json_type(p.data_json,'$.memberCount') IN ('integer','real')
    AND json_type(NEW.data_json,'$.memberCount') IN ('integer','real')
    AND json_extract(p.data_json,'$.memberCount')>=0
    AND json_extract(NEW.data_json,'$.memberCount')>=json_extract(p.data_json,'$.memberCount')+5
    AND json_extract(NEW.data_json,'$.memberCount')>=json_extract(p.data_json,'$.memberCount')*1.2;
END;

-- Existing census records never alert on first sighting. Both transition endpoints must be known.
CREATE TRIGGER IF NOT EXISTS event_player_country AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='players' AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'player-country:'||NEW.id,'Observed player country change',
    COALESCE(json_extract(NEW.data_json,'$.countryId'),json_extract(NEW.data_json,'$.country')),
    'player-country',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM players WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','activity','severity','info','entityType','players','entityId',NEW.entity_id,
      'rule','known-country-transition','verification','two-public-player-snapshots',
      'before',json_object('country',COALESCE(json_extract(p.data_json,'$.countryId'),json_extract(p.data_json,'$.country'))),
      'after',json_object('country',COALESCE(json_extract(NEW.data_json,'$.countryId'),json_extract(NEW.data_json,'$.country'))),
      'explanation','The player country differs between captured public records; the exact change time is unknown.')
  FROM entity_snapshots p WHERE p.id=(SELECT id FROM entity_snapshots
    WHERE entity_type='players' AND entity_id=NEW.entity_id AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND COALESCE(json_extract(p.data_json,'$.countryId'),json_extract(p.data_json,'$.country')) IS NOT NULL
    AND COALESCE(json_extract(NEW.data_json,'$.countryId'),json_extract(NEW.data_json,'$.country')) IS NOT NULL
    AND COALESCE(json_extract(p.data_json,'$.countryId'),json_extract(p.data_json,'$.country'))<>
      COALESCE(json_extract(NEW.data_json,'$.countryId'),json_extract(NEW.data_json,'$.country'));
END;
CREATE TRIGGER IF NOT EXISTS event_player_party AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='players' AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'player-party:'||NEW.id,'Observed player party change',json_extract(NEW.data_json,'$.countryId'),
    'player-party',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM players WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','politics','severity','info','entityType','players','entityId',NEW.entity_id,
      'rule','known-party-transition','verification','two-public-player-snapshots',
      'before',json_object('party',COALESCE(json_extract(p.data_json,'$.party_id'),json_extract(p.data_json,'$.party'))),
      'after',json_object('party',COALESCE(json_extract(NEW.data_json,'$.party_id'),json_extract(NEW.data_json,'$.party'))),
      'explanation','The player party differs between captured public records; the exact change time is unknown.')
  FROM entity_snapshots p WHERE p.id=(SELECT id FROM entity_snapshots
    WHERE entity_type='players' AND entity_id=NEW.entity_id AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND COALESCE(json_extract(p.data_json,'$.party_id'),json_extract(p.data_json,'$.party')) IS NOT NULL
    AND COALESCE(json_extract(NEW.data_json,'$.party_id'),json_extract(NEW.data_json,'$.party')) IS NOT NULL
    AND COALESCE(json_extract(p.data_json,'$.party_id'),json_extract(p.data_json,'$.party'))<>
      COALESCE(json_extract(NEW.data_json,'$.party_id'),json_extract(NEW.data_json,'$.party'));
END;
CREATE TRIGGER IF NOT EXISTS event_player_unit AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='players' AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'player-unit:'||NEW.id,'Observed player unit change',json_extract(NEW.data_json,'$.countryId'),
    'player-unit',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM players WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','military','severity','info','entityType','players','entityId',NEW.entity_id,
      'rule','known-unit-transition','verification','two-public-player-snapshots',
      'before',json_object('unit',COALESCE(json_extract(p.data_json,'$.military_unit_id'),json_extract(p.data_json,'$.mu'))),
      'after',json_object('unit',COALESCE(json_extract(NEW.data_json,'$.military_unit_id'),json_extract(NEW.data_json,'$.mu'))),
      'explanation','The player military unit differs between captured public records; the exact change time is unknown.')
  FROM entity_snapshots p WHERE p.id=(SELECT id FROM entity_snapshots
    WHERE entity_type='players' AND entity_id=NEW.entity_id AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND COALESCE(json_extract(p.data_json,'$.military_unit_id'),json_extract(p.data_json,'$.mu')) IS NOT NULL
    AND COALESCE(json_extract(NEW.data_json,'$.military_unit_id'),json_extract(NEW.data_json,'$.mu')) IS NOT NULL
    AND COALESCE(json_extract(p.data_json,'$.military_unit_id'),json_extract(p.data_json,'$.mu'))<>
      COALESCE(json_extract(NEW.data_json,'$.military_unit_id'),json_extract(NEW.data_json,'$.mu'));
END;

CREATE TRIGGER IF NOT EXISTS event_election_finished AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='elections' AND json_extract(NEW.data_json,'$.isActive')=0
 AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1)
 AND lower(json_extract(NEW.data_json,'$.status')) IN ('completed','finished','ended','closed','concluded')
BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'election-finished:'||NEW.id,'Election finished in public record',json_extract(NEW.data_json,'$.countryId'),
    'election-finished',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM elections WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','politics','severity','notable','entityType','elections','entityId',NEW.entity_id,
      'rule','explicit-inactive-completed-status','verification','public-election-status',
      'before',NULL,'after',json_object('status',json_extract(NEW.data_json,'$.status'),
        'votesCount',json_extract(NEW.data_json,'$.votesCount'),'electedCount',json_extract(NEW.data_json,'$.electedCount')),
      'explanation','The captured election record explicitly reports an inactive completed status; candidate totals are official API fields.')
  WHERE NOT EXISTS(SELECT 1 FROM entity_snapshots p WHERE p.entity_type='elections' AND p.entity_id=NEW.entity_id AND p.id<NEW.id
    AND json_extract(p.data_json,'$.isActive')=0
    AND lower(json_extract(p.data_json,'$.status')) IN ('completed','finished','ended','closed','concluded'))
    AND NOT EXISTS(SELECT 1 FROM events e WHERE e.event_type='election-finished' AND json_extract(e.data_json,'$.entityId')=NEW.entity_id);
END;

CREATE TRIGGER IF NOT EXISTS event_article_keyword AFTER INSERT ON entity_snapshots
WHEN NEW.entity_type='articles' AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) AND (
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'battle')>0 OR
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'election')>0 OR
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'president')>0 OR
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'market')>0 OR
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'batalla')>0 OR
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'elecci')>0 OR
  instr(lower(COALESCE(json_extract(NEW.data_json,'$.title'),'')),'mercado')>0)
 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.event_type='article-keyword'
   AND json_extract(e.data_json,'$.entityId')=NEW.entity_id
   AND json_extract(e.data_json,'$.after.title')=substr(json_extract(NEW.data_json,'$.title'),1,300))
BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  VALUES('article-keyword:'||NEW.id,'Article title matched a monitored topic',json_extract(NEW.data_json,'$.countryId'),
    'article-keyword',COALESCE(json_extract(NEW.data_json,'$.source_url'),(SELECT source_url FROM articles WHERE id=NEW.entity_id)),
    NEW.captured_at,NEW.captured_at,NEW.hash,
    json_object('theme','media','severity','info','entityType','articles','entityId',NEW.entity_id,
      'rule','public-title-keyword','verification','title-metadata-only','before',NULL,
      'after',json_object('title',substr(json_extract(NEW.data_json,'$.title'),1,300)),
      'explanation','A public article title matched a monitored term. No body text was read or classified.'));
END;

CREATE TRIGGER IF NOT EXISTS event_price_move AFTER INSERT ON market_prices
WHEN NEW.price>0 AND EXISTS(SELECT 1 FROM source_registry WHERE id='events' AND enabled=1) BEGIN
  INSERT OR IGNORE INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json)
  SELECT 'price-move:'||NEW.id,'Observed market price change over 20%',NEW.country_id,'price-move',
    NEW.source_url,NEW.captured_at,NEW.captured_at,'price:'||NEW.id,
    json_object('theme','economy','severity','notable','entityType','markets','entityId',NEW.item_id,
      'rule','absolute-change-over-20-percent-from-prior-nonzero-quote','verification','two-public-price-observations',
      'before',json_object('price',p.price,'capturedAt',p.captured_at),
      'after',json_object('price',NEW.price,'capturedAt',NEW.captured_at),
      'explanation','The public quoted item price differs by more than 20% from the preceding nonzero observation. This is not executed trade volume.')
  FROM market_prices p WHERE p.id=(SELECT id FROM market_prices
    WHERE item_id=NEW.item_id AND country_id IS NEW.country_id AND price>0 AND id<NEW.id ORDER BY id DESC LIMIT 1)
    AND p.price>0 AND abs(NEW.price-p.price)>p.price*0.2;
END;
