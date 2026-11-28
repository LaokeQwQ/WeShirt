-- Staged values travel through small gateway requests and become visible in one commit.
CREATE TABLE weshirt_site_private.uploads (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  key text COLLATE "C",
  parts integer,
  part_digests jsonb,
  result boolean
);
CREATE INDEX site_store_upload_expiry ON weshirt_site_private.uploads (expires_at);
CREATE TABLE weshirt_site_private.upload_parts (
  id uuid NOT NULL REFERENCES weshirt_site_private.uploads(id) ON DELETE CASCADE,
  part integer NOT NULL CHECK (part BETWEEN 0 AND 511),
  content text NOT NULL CHECK (pg_catalog.octet_length(content) BETWEEN 1 AND 120000),
  PRIMARY KEY (id, part)
);

ALTER TABLE weshirt_site_private.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE weshirt_site_private.uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE weshirt_site_private.upload_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE weshirt_site_private.upload_parts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE weshirt_site_private.uploads, weshirt_site_private.upload_parts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE weshirt_site_private.uploads TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE weshirt_site_private.upload_parts TO service_role;
CREATE POLICY uploads_service_only ON weshirt_site_private.uploads TO service_role USING (true) WITH CHECK (true);
CREATE POLICY upload_parts_service_only ON weshirt_site_private.upload_parts TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.weshirt_site_store_stage(p_id text, p_part integer, p_text text, p_import boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
DECLARE
  v_id uuid;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_upload weshirt_site_private.uploads%ROWTYPE;
  v_existing text;
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_id IS NULL OR p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR p_part IS NULL OR p_part NOT BETWEEN 0 AND 511
      OR p_text IS NULL OR pg_catalog.octet_length(p_text) NOT BETWEEN 1 AND 120000 OR p_import IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_upload_part';
  END IF;
  v_id := pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_import::text || ':' || p_id, 'UTF8')), 'hex'), 1, 32)::uuid;

  -- Keep cleanup bounded and never wait on an upload another request is using.
  DELETE FROM weshirt_site_private.uploads WHERE id IN (
    SELECT id FROM weshirt_site_private.uploads
      WHERE expires_at <= v_now AND id <> v_id ORDER BY expires_at LIMIT 4 FOR UPDATE SKIP LOCKED
  );
  INSERT INTO weshirt_site_private.uploads (id, expires_at)
    VALUES (v_id, v_now + interval '1 hour') ON CONFLICT (id) DO NOTHING;
  SELECT * INTO STRICT v_upload FROM weshirt_site_private.uploads WHERE id = v_id FOR UPDATE;
  IF v_upload.expires_at <= v_now THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_upload_expired';
  END IF;
  IF v_upload.result IS NOT NULL THEN
    IF (v_upload.part_digests ->> p_part) IS DISTINCT FROM
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_upload_part_changed';
    END IF;
    RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', true);
  END IF;
  SELECT content INTO v_existing FROM weshirt_site_private.upload_parts WHERE id = v_id AND part = p_part;
  IF NOT FOUND THEN
    INSERT INTO weshirt_site_private.upload_parts (id, part, content) VALUES (v_id, p_part, p_text);
  ELSIF v_existing IS DISTINCT FROM p_text THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_upload_part_changed';
  END IF;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', true);
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_commit(p_id text, p_parts integer, p_key text, p_import boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
DECLARE
  v_id uuid;
  v_upload weshirt_site_private.uploads%ROWTYPE;
  v_count integer;
  v_last integer;
  v_bytes bigint;
  v_value jsonb;
  v_digests jsonb;
  v_result boolean;
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_id IS NULL OR p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR p_parts IS NULL OR p_parts NOT BETWEEN 1 AND 512
      OR p_key IS NULL OR pg_catalog.octet_length(p_key) NOT BETWEEN 1 AND 512 OR p_import IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_upload_commit';
  END IF;
  v_id := pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_import::text || ':' || p_id, 'UTF8')), 'hex'), 1, 32)::uuid;
  SELECT * INTO v_upload FROM weshirt_site_private.uploads WHERE id = v_id FOR UPDATE;
  IF NOT FOUND OR v_upload.expires_at <= pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_upload_missing_or_expired';
  END IF;
  IF v_upload.result IS NOT NULL THEN
    IF v_upload.key IS DISTINCT FROM p_key OR v_upload.parts IS DISTINCT FROM p_parts THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_upload_commit_changed';
    END IF;
    RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', v_upload.result);
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.max(part), pg_catalog.sum(pg_catalog.octet_length(content))
    INTO v_count, v_last, v_bytes FROM weshirt_site_private.upload_parts WHERE id = v_id;
  IF v_count <> p_parts OR v_last IS DISTINCT FROM p_parts - 1 OR v_bytes > 33554432 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_upload_parts_incomplete_or_large';
  END IF;
  SELECT pg_catalog.string_agg(content, '' ORDER BY part)::jsonb,
    pg_catalog.jsonb_agg(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')), 'hex') ORDER BY part)
    INTO v_value, v_digests FROM weshirt_site_private.upload_parts WHERE id = v_id;
  IF p_import THEN
    INSERT INTO weshirt_site_private.entries (key, value) VALUES (p_key, v_value)
      ON CONFLICT (key) DO NOTHING;
    v_result := FOUND;
  ELSE
    INSERT INTO weshirt_site_private.entries (key, value) VALUES (p_key, v_value)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL;
    v_result := true;
  END IF;
  UPDATE weshirt_site_private.uploads SET key = p_key, parts = p_parts, part_digests = v_digests, result = v_result WHERE id = v_id;
  DELETE FROM weshirt_site_private.upload_parts WHERE id = v_id;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', v_result);
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_read_chunk(p_key text, p_offset integer DEFAULT 0, p_digest text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_value text;
  v_digest text;
  v_chunk text;
  v_next integer;
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_key IS NULL OR pg_catalog.octet_length(p_key) NOT BETWEEN 1 AND 512 OR p_offset IS NULL
      OR p_offset NOT BETWEEN 0 AND 33554432
      OR p_offset = 0 AND p_digest IS NOT NULL
      OR p_offset > 0 AND (p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_read_cursor';
  END IF;
  SELECT value::text INTO v_value FROM weshirt_site_private.entries
    WHERE key = p_key AND (expires_at IS NULL OR expires_at > pg_catalog.statement_timestamp());
  IF NOT FOUND AND p_offset = 0 THEN
    RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', pg_catalog.jsonb_build_object('found', false));
  END IF;
  v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_value, 'UTF8')), 'hex');
  IF p_offset > 0 AND (v_digest IS DISTINCT FROM p_digest OR p_offset >= pg_catalog.char_length(v_value)) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'site_store_read_changed';
  END IF;
  v_chunk := pg_catalog.substr(v_value, p_offset + 1, 70000);
  IF pg_catalog.octet_length(pg_catalog.to_jsonb(v_chunk)::text) > 90000 THEN
    v_chunk := pg_catalog.substr(v_chunk, 1, 10000);
  END IF;
  v_next := p_offset + pg_catalog.char_length(v_chunk);
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result',
    pg_catalog.jsonb_build_object('found', true, 'text', v_chunk, 'digest', v_digest,
      'next', CASE WHEN v_next < pg_catalog.char_length(v_value) THEN v_next END));
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_list_keys(p_prefix text, p_after text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_rows jsonb;
  v_next text;
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_prefix IS NULL OR pg_catalog.octet_length(p_prefix) > 512
      OR p_after IS NOT NULL AND (pg_catalog.octet_length(p_after) NOT BETWEEN 1 AND 512
        OR NOT pg_catalog.starts_with(p_after, p_prefix))
      OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_page';
  END IF;
  WITH candidates AS (
    SELECT key, value FROM weshirt_site_private.entries
    WHERE key >= p_prefix AND (p_after IS NULL OR key > p_after)
      AND pg_catalog.starts_with(key, p_prefix)
      AND (expires_at IS NULL OR expires_at > pg_catalog.statement_timestamp())
    ORDER BY key
    LIMIT p_limit + 1
  ), paged AS (
    SELECT key,
      CASE WHEN pg_catalog.octet_length(value::text) <= 49152
        THEN pg_catalog.jsonb_build_object('key', key, 'value', value)
        ELSE pg_catalog.jsonb_build_object('key', key, 'chunked', true) END AS item
    FROM candidates
  ), sized AS (
    SELECT key, item, pg_catalog.row_number() OVER (ORDER BY key) AS position,
      pg_catalog.sum(pg_catalog.octet_length(item::text) + 8) OVER (ORDER BY key) AS bytes
    FROM paged
  ), page AS (
    SELECT *, position <= p_limit AND bytes <= 65536 AS included FROM sized
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY key) FILTER (WHERE included), '[]'::jsonb),
    CASE WHEN pg_catalog.bool_or(NOT included) THEN pg_catalog.max(key) FILTER (WHERE included) END
    INTO v_rows, v_next FROM page;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result',
    pg_catalog.jsonb_build_object('rows', v_rows, 'next', v_next));
END;
$function$;

REVOKE ALL ON FUNCTION public.weshirt_site_store_stage(text, integer, text, boolean),
  public.weshirt_site_store_commit(text, integer, text, boolean), public.weshirt_site_store_read_chunk(text, integer, text),
  public.weshirt_site_store_list_keys(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weshirt_site_store_stage(text, integer, text, boolean),
  public.weshirt_site_store_commit(text, integer, text, boolean), public.weshirt_site_store_read_chunk(text, integer, text),
  public.weshirt_site_store_list_keys(text, text, integer) TO service_role;
