-- v1 pilot schema. All tables live in a dedicated strategic service database.
CREATE TABLE IF NOT EXISTS strategic_rooms (
  id text PRIMARY KEY,
  rules_pin text NOT NULL,
  scenario jsonb NOT NULL,
  projection_key bytea NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  turn_id integer NOT NULL DEFAULT 1,
  phase text NOT NULL DEFAULT 'orders' CHECK (phase IN ('orders','resolution','report','paused')),
  version integer NOT NULL DEFAULT 0,
  deadline_ms bigint
);
CREATE TABLE IF NOT EXISTS strategic_members (
  room_id text NOT NULL REFERENCES strategic_rooms(id) ON DELETE CASCADE,
  id text NOT NULL,
  role text NOT NULL CHECK (role IN ('GM','PLAYER')),
  faction_id text,
  public_key text,
  invite_hash text,
  invite_expires timestamptz,
  epoch integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (room_id, id),
  UNIQUE (room_id, public_key),
  UNIQUE (room_id, invite_hash)
);
CREATE TABLE IF NOT EXISTS strategic_versions (
  room_id text NOT NULL REFERENCES strategic_rooms(id) ON DELETE CASCADE,
  version integer NOT NULL,
  checkpoint bytea NOT NULL,
  hp_max real NOT NULL,
  pool_hash text NOT NULL,
  units jsonb NOT NULL,
  raw_report bytea,
  PRIMARY KEY (room_id, version)
);
CREATE TABLE IF NOT EXISTS strategic_frozen (
  room_id text NOT NULL REFERENCES strategic_rooms(id) ON DELETE CASCADE,
  turn_id integer NOT NULL,
  start_version integer NOT NULL,
  rules_pin text NOT NULL,
  seed bigint NOT NULL,
  orders jsonb NOT NULL,
  revisions jsonb NOT NULL,
  PRIMARY KEY (room_id, turn_id),
  FOREIGN KEY (room_id, start_version) REFERENCES strategic_versions(room_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS strategic_orders (
  room_id text NOT NULL,
  turn_id integer NOT NULL,
  unit_id text NOT NULL,
  member_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (room_id, turn_id, unit_id),
  FOREIGN KEY (room_id, member_id) REFERENCES strategic_members(room_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS strategic_orders_member ON strategic_orders(room_id, turn_id, member_id);
CREATE TABLE IF NOT EXISTS strategic_revisions (
  room_id text NOT NULL,
  turn_id integer NOT NULL,
  member_id text NOT NULL,
  revision integer NOT NULL,
  PRIMARY KEY (room_id, turn_id, member_id),
  FOREIGN KEY (room_id, member_id) REFERENCES strategic_members(room_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS strategic_receipts (
  room_id text NOT NULL,
  member_id text NOT NULL,
  request_id text NOT NULL,
  digest text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (room_id, member_id, request_id),
  FOREIGN KEY (room_id, member_id) REFERENCES strategic_members(room_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS strategic_report_rows (
  room_id text NOT NULL,
  version integer NOT NULL,
  member_id text NOT NULL,
  unit_id text NOT NULL,
  row jsonb NOT NULL,
  PRIMARY KEY (room_id, version, unit_id),
  FOREIGN KEY (room_id, version) REFERENCES strategic_versions(room_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS strategic_report_member ON strategic_report_rows(room_id, version, member_id, unit_id);
