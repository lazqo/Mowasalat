-- Mowasalat: the durable half of the system.
--
-- What lives here is everything a restart must not lose: the network (countries,
-- hubs, destinations, lines and their corridors) and the roster (drivers,
-- vehicles, line assignments, verification state).
--
-- What deliberately does NOT live here is live movement. There is no trip table,
-- no position column and no ride-request table anywhere in this file, and that
-- absence is the point (docs/PLAN.md §6.2): a stored movement trail is the one
-- thing we promised never to build. Live state stays in memory with a 60-second
-- expiry and is expected to be lost on restart.
--
-- Geometry is JSONB rather than PostGIS. Every spatial computation in this
-- system happens on the phone, by design, so the server runs no spatial queries
-- and PostGIS would earn nothing yet. It becomes worth adding the day the server
-- needs to ask a spatial question.

create table if not exists country (
  code           text primary key,
  name_ar        text not null,
  locale         text not null,
  digits         text not null,
  phone_prefix   text not null,
  bounds         jsonb,
  -- Residency, vouching authorities, tier thresholds, corridor width, anonymity
  -- floor: policy travels with the country, never hardcoded (§11).
  policy         jsonb not null default '{}'::jsonb
);

create table if not exists city (
  id             text primary key,
  country_code   text not null references country(code) on delete cascade,
  name_ar        text not null,
  centre_lat     double precision,
  centre_lng     double precision
);

-- المجمع / الموقف: where a line's vehicles gather and depart.
create table if not exists hub (
  id             text primary key,
  country_code   text not null references country(code) on delete cascade,
  city_id        text references city(id) on delete set null,
  name_ar        text not null,
  lat            double precision,
  lng            double precision,
  aliases_ar     text[] not null default '{}'
);

create table if not exists destination (
  id             text primary key,
  country_code   text not null references country(code) on delete cascade,
  name_ar        text not null,
  lat            double precision,
  lng            double precision,
  aliases_ar     text[] not null default '{}'
);

-- A route is the transport service a person recognises: إربد ↔ ملكا. An origin,
-- a destination, two directions. It is NOT a street-by-street path.
create table if not exists route (
  id                   text primary key,
  country_code         text not null references country(code) on delete cascade,
  name_ar              text not null,
  -- Nullable until Phase 0 identifies which موقف each line actually uses.
  origin_hub_id        text references hub(id) on delete set null,
  origin_name_ar       text not null,
  destination_id       text references destination(id) on delete set null,
  destination_name_ar  text not null,
  bidirectional        boolean not null default true,
  typical_headway_min  int,
  active               boolean not null default true,
  -- True while the geometry is still a placeholder awaiting field work.
  provisional          boolean not null default true,
  updated_at           timestamptz not null default now()
);

-- The corridor is the geographic representation used on-device for matching. It
-- is kept apart from the route's identity precisely because a driver is never
-- required to follow it street by street (§9.1).
create table if not exists route_corridor (
  route_id         text primary key references route(id) on delete cascade,
  width_m          int not null,
  -- The roads drivers actually use, including known alternatives.
  reference_paths  jsonb not null
);

create table if not exists route_zone (
  route_id     text not null references route(id) on delete cascade,
  seq          int  not null,
  name_ar      text not null,
  kind         text not null check (kind in ('origin_hub', 'intermediate', 'destination')),
  centre_lat   double precision not null,
  centre_lng   double precision not null,
  radius_m     int not null,
  primary key (route_id, seq)
);

create table if not exists route_destination (
  route_id        text not null references route(id) on delete cascade,
  destination_id  text not null,
  zone_seq        int  not null,
  kind            text not null default 'intermediate'
                    check (kind in ('terminus', 'intermediate')),
  primary key (route_id, destination_id)
);

create table if not exists wait_point (
  id         text primary key,
  route_id   text not null references route(id) on delete cascade,
  zone_seq   int  not null,
  name_ar    text not null,
  lat        double precision not null,
  lng        double precision not null
);

-- The roster is the only place in the system holding anything personal, and it
-- never reaches the realtime layer (§6.4). The phone number itself is not
-- stored: lookup is by salted hash, display is the masked tail.
create table if not exists driver (
  id             text primary key,
  country_code   text not null references country(code) on delete cascade,
  phone_hash     text not null unique,
  phone_masked   text not null,
  tier           smallint not null default 0 check (tier between 0 and 3),
  status         text not null default 'active' check (status in ('active', 'blocked')),
  vouched_by     text,
  proven_trips   int not null default 0,
  proven_days    int not null default 0,
  created_at     timestamptz not null default now()
);

create table if not exists vehicle (
  id          text primary key,
  driver_id   text not null references driver(id) on delete cascade,
  type        text not null check (type in ('coaster', 'minibus', 'service')),
  colour      text,
  plate       text,
  show_plate  boolean not null default false
);

-- A driver may be assigned to several lines. At the start of a shift he selects
-- exactly one of them, and one direction, and that is the trip (§5.4).
create table if not exists driver_route (
  driver_id    text not null references driver(id) on delete cascade,
  route_id     text not null references route(id) on delete cascade,
  assigned_at  timestamptz not null default now(),
  primary key (driver_id, route_id)
);

create index if not exists route_country_idx on route (country_code) where active;
create index if not exists driver_route_route_idx on driver_route (route_id);
create index if not exists destination_country_idx on destination (country_code);
