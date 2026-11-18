CREATE TABLE IF NOT EXISTS nb_novels (
 id uuid PRIMARY KEY, owner text NOT NULL, title text NOT NULL, canon text NOT NULL DEFAULT '',
 canon_revision integer NOT NULL DEFAULT 0, epoch integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nb_novels_owner ON nb_novels(owner);
CREATE TABLE IF NOT EXISTS nb_canon_revisions (
 novel_id uuid NOT NULL REFERENCES nb_novels(id), revision integer NOT NULL CHECK(revision > 0),
 canon text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(novel_id,revision)
);
CREATE TABLE IF NOT EXISTS nb_revisions (
 novel_id uuid NOT NULL REFERENCES nb_novels(id), chapter_no integer NOT NULL CHECK(chapter_no > 0), revision integer NOT NULL CHECK(revision > 0),
 title text NOT NULL, content text NOT NULL, summary text NOT NULL, state_delta jsonb NOT NULL,
 story_time text NOT NULL, source_chat_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(novel_id, chapter_no, revision)
);
CREATE TABLE IF NOT EXISTS nb_chapters (
 novel_id uuid NOT NULL REFERENCES nb_novels(id), chapter_no integer NOT NULL, active_revision integer NOT NULL, needs_review boolean NOT NULL DEFAULT false,
 PRIMARY KEY(novel_id, chapter_no), FOREIGN KEY(novel_id, chapter_no, active_revision) REFERENCES nb_revisions(novel_id,chapter_no,revision)
);
CREATE TABLE IF NOT EXISTS nb_jobs (
 id uuid PRIMARY KEY, novel_id uuid NOT NULL, chapter_no integer NOT NULL, revision integer NOT NULL,
 operation_id uuid NOT NULL UNIQUE, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','paused','synced','failed')),
 attempts integer NOT NULL DEFAULT 0, terminal boolean NOT NULL DEFAULT false, exported boolean NOT NULL DEFAULT false,
 error text, retry_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(novel_id,chapter_no,revision), FOREIGN KEY(novel_id,chapter_no,revision) REFERENCES nb_revisions(novel_id,chapter_no,revision)
);
CREATE INDEX IF NOT EXISTS nb_jobs_ready ON nb_jobs(status,retry_at);
CREATE TABLE IF NOT EXISTS nb_requests (
 novel_id uuid NOT NULL REFERENCES nb_novels(id), request_id uuid NOT NULL, payload_hash text NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(novel_id,request_id)
);

-- Chat memory uses immutable source objects and revisions. Only the ordered active
-- manifest is eligible for recall; indexing is asynchronous and never authoritative.
CREATE TABLE IF NOT EXISTS nb_chat_vaults (
 id uuid PRIMARY KEY, owner text NOT NULL, binding text NOT NULL,
 epoch integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nb_chat_owner ON nb_chat_vaults(owner);
CREATE TABLE IF NOT EXISTS nb_chat_objects (
 vault_id uuid NOT NULL REFERENCES nb_chat_vaults(id), message_id uuid NOT NULL,
 content_hash text NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')), name text NOT NULL, content text NOT NULL,
 PRIMARY KEY(vault_id,message_id,content_hash)
);
CREATE TABLE IF NOT EXISTS nb_chat_revisions (
 vault_id uuid NOT NULL REFERENCES nb_chat_vaults(id), message_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), content_hash text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(vault_id,message_id,revision),
 FOREIGN KEY(vault_id,message_id,content_hash) REFERENCES nb_chat_objects(vault_id,message_id,content_hash)
);
CREATE TABLE IF NOT EXISTS nb_chat_entries (
 vault_id uuid NOT NULL, message_id uuid NOT NULL, revision integer NOT NULL, content_hash text, position integer CHECK(position>=0),
 PRIMARY KEY(vault_id,message_id),
 FOREIGN KEY(vault_id,message_id,revision) REFERENCES nb_chat_revisions(vault_id,message_id,revision),
 CHECK((position IS NULL)=(content_hash IS NULL))
);
CREATE TABLE IF NOT EXISTS nb_chat_jobs (
 id uuid PRIMARY KEY, vault_id uuid NOT NULL, message_id uuid NOT NULL, revision integer NOT NULL,
 operation_id uuid NOT NULL UNIQUE, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','paused','synced','failed')),
 attempts integer NOT NULL DEFAULT 0, terminal boolean NOT NULL DEFAULT false, exported boolean NOT NULL DEFAULT false,
 error text, retry_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(vault_id,message_id,revision), FOREIGN KEY(vault_id,message_id,revision) REFERENCES nb_chat_revisions(vault_id,message_id,revision)
);
CREATE INDEX IF NOT EXISTS nb_chat_jobs_ready ON nb_chat_jobs(status,retry_at);
