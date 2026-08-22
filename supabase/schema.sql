create extension if not exists vector;
create extension if not exists pgcrypto;

do $$ begin
  create type file_status as enum ('UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIALLY_PROCESSED');
exception when duplicate_object then null; end $$;

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  original_filename text not null,
  storage_path text not null,
  mime_type text not null,
  modality text not null check (modality in ('pdf', 'image', 'video', 'audio', 'document')),
  file_size bigint not null check (file_size > 0),
  checksum text not null,
  status file_status not null default 'UPLOADED',
  processing_progress integer not null default 0 check (processing_progress between 0 and 100),
  processing_error text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists files_user_checksum_idx on files (user_id, checksum);
create index if not exists files_user_status_idx on files (user_id, status);

create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  kind text not null default 'PROCESS_FILE',
  status text not null default 'QUEUED' check (status in ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists observations (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  modality text not null,
  kind text not null,
  content text not null,
  page_number integer,
  timestamp_start double precision,
  timestamp_end double precision,
  frame_timestamp double precision,
  bounding_box jsonb,
  artifact_path text,
  confidence double precision,
  metadata jsonb not null default '{}',
  tsv tsvector generated always as (to_tsvector('english', coalesce(content, ''))) stored,
  created_at timestamptz not null default now()
);

create index if not exists observations_file_idx on observations(file_id);
create index if not exists observations_tsv_idx on observations using gin(tsv);
create index if not exists observations_time_idx on observations(file_id, timestamp_start, timestamp_end, frame_timestamp);

create table if not exists observation_embeddings (
  observation_id uuid primary key references observations(id) on delete cascade,
  embedding vector(768),
  created_at timestamptz not null default now()
);

create index if not exists observation_embeddings_vec_idx
  on observation_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  canonical_name text not null,
  entity_type text not null,
  aliases text[] not null default '{}',
  confidence double precision,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists observation_entities (
  observation_id uuid references observations(id) on delete cascade,
  entity_id uuid references entities(id) on delete cascade,
  role text,
  confidence double precision,
  primary key (observation_id, entity_id)
);

create table if not exists evidence_relationships (
  id uuid primary key default gen_random_uuid(),
  source_observation_id uuid not null references observations(id) on delete cascade,
  target_observation_id uuid not null references observations(id) on delete cascade,
  relationship_type text not null,
  confidence double precision,
  evidence text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists evidence_relationships_source_idx on evidence_relationships(source_observation_id);
create index if not exists evidence_relationships_target_idx on evidence_relationships(target_observation_id);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  title text,
  start_time double precision,
  end_time double precision,
  page_number integer,
  confidence double precision,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists event_observations (
  event_id uuid references events(id) on delete cascade,
  observation_id uuid references observations(id) on delete cascade,
  relationship_type text not null,
  primary key (event_id, observation_id, relationship_type)
);

create table if not exists speakers (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references files(id) on delete cascade,
  diarization_label text not null,
  display_name text,
  identity_state text not null default 'DIARIZED_ONLY' check (identity_state in ('IDENTIFIED', 'DIARIZED_ONLY', 'UNKNOWN', 'CONFLICTING')),
  confidence double precision,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists speakers_file_label_idx on speakers(file_id, diarization_label);

create table if not exists speaker_segments (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  speaker_id uuid references speakers(id) on delete set null,
  diarization_label text not null,
  start_time double precision not null,
  end_time double precision not null,
  confidence double precision,
  observation_id uuid references observations(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists frames (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  observation_id uuid references observations(id) on delete set null,
  timestamp double precision not null,
  artifact_path text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists faces (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  frame_id uuid references frames(id) on delete cascade,
  timestamp double precision not null,
  bounding_box jsonb not null,
  track_id text not null,
  confidence double precision,
  created_at timestamptz not null default now()
);

create table if not exists face_tracks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  track_id text not null,
  display_name text,
  identity_state text not null default 'UNKNOWN' check (identity_state in ('IDENTIFIED', 'UNKNOWN', 'CONFLICTING')),
  confidence double precision,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists face_tracks_file_track_idx on face_tracks(file_id, track_id);

create table if not exists speaker_face_links (
  id uuid primary key default gen_random_uuid(),
  speaker_segment_id uuid references speaker_segments(id) on delete cascade,
  face_track_id uuid references face_tracks(id) on delete cascade,
  confidence double precision,
  method text not null,
  identity_state text not null check (identity_state in ('IDENTIFIED', 'DIARIZED_ONLY', 'UNKNOWN', 'CONFLICTING')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create or replace function match_observations(
  query_embedding vector(768),
  match_count int,
  user_id_filter text
)
returns table (
  id uuid,
  file_id uuid,
  original_filename text,
  modality text,
  kind text,
  content text,
  page_number integer,
  timestamp_start double precision,
  timestamp_end double precision,
  frame_timestamp double precision,
  bounding_box jsonb,
  artifact_path text,
  confidence double precision,
  score double precision
)
language sql stable as $$
  select
    o.id, o.file_id, f.original_filename, o.modality, o.kind, o.content,
    o.page_number, o.timestamp_start, o.timestamp_end, o.frame_timestamp,
    o.bounding_box, o.artifact_path, o.confidence,
    1 - (e.embedding <=> query_embedding) as score
  from observation_embeddings e
  join observations o on o.id = e.observation_id
  join files f on f.id = o.file_id
  where f.user_id = user_id_filter
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function keyword_observations(
  query_text text,
  match_count int,
  user_id_filter text
)
returns table (
  id uuid,
  file_id uuid,
  original_filename text,
  modality text,
  kind text,
  content text,
  page_number integer,
  timestamp_start double precision,
  timestamp_end double precision,
  frame_timestamp double precision,
  bounding_box jsonb,
  artifact_path text,
  confidence double precision,
  score double precision
)
language sql stable as $$
  select
    o.id, o.file_id, f.original_filename, o.modality, o.kind, o.content,
    o.page_number, o.timestamp_start, o.timestamp_end, o.frame_timestamp,
    o.bounding_box, o.artifact_path, o.confidence,
    ts_rank(o.tsv, plainto_tsquery('english', query_text))::double precision as score
  from observations o
  join files f on f.id = o.file_id
  where f.user_id = user_id_filter
    and o.tsv @@ plainto_tsquery('english', query_text)
  order by score desc
  limit match_count;
$$;

create or replace function expand_related_observations(
  seed_ids uuid[],
  temporal_window_seconds double precision
)
returns table (
  id uuid,
  file_id uuid,
  original_filename text,
  modality text,
  kind text,
  content text,
  page_number integer,
  timestamp_start double precision,
  timestamp_end double precision,
  frame_timestamp double precision,
  bounding_box jsonb,
  artifact_path text,
  confidence double precision,
  score double precision
)
language sql stable as $$
  with seed as (
    select * from observations where observations.id = any(seed_ids)
  ),
  related as (
    select er.target_observation_id as id, coalesce(er.confidence, 0.65) as score
    from evidence_relationships er where er.source_observation_id = any(seed_ids)
    union
    select er.source_observation_id as id, coalesce(er.confidence, 0.65) as score
    from evidence_relationships er where er.target_observation_id = any(seed_ids)
    union
    select o.id, 0.55 as score
    from observations o
    join seed s on s.file_id = o.file_id
    where coalesce(o.timestamp_start, o.frame_timestamp) is not null
      and coalesce(s.timestamp_start, s.frame_timestamp) is not null
      and abs(coalesce(o.timestamp_start, o.frame_timestamp) - coalesce(s.timestamp_start, s.frame_timestamp)) <= temporal_window_seconds
    union
    select o.id, 0.45 as score
    from observations o
    join seed s on s.file_id = o.file_id and s.page_number is not null and o.page_number = s.page_number
  )
  select
    o.id, o.file_id, f.original_filename, o.modality, o.kind, o.content,
    o.page_number, o.timestamp_start, o.timestamp_end, o.frame_timestamp,
    o.bounding_box, o.artifact_path, o.confidence, max(related.score) as score
  from related
  join observations o on o.id = related.id
  join files f on f.id = o.file_id
  group by o.id, f.original_filename
  order by score desc
  limit 24;
$$;
