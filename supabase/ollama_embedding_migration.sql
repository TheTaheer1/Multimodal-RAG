-- Safe migration for switching existing OpenAI 1536-dimension embeddings to
-- Ollama nomic-embed-text 768-dimension embeddings.
--
-- This preserves files, observations, entities, relationships, timestamps,
-- speakers, provenance, and processing jobs. Only old incompatible embedding
-- vectors are removed, because 1536-dimension vectors cannot be converted into
-- 768-dimension vectors without re-embedding the original text.

drop function if exists match_observations(vector(1536), int, text);
drop index if exists observation_embeddings_vec_idx;

create table if not exists observation_embeddings_openai_1536_backup as
select * from observation_embeddings;

truncate table observation_embeddings;

alter table observation_embeddings
  alter column embedding type vector(768);

create index if not exists observation_embeddings_vec_idx
  on observation_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

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
