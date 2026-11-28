-- The site store is private. RPC callers need a server role, in addition to table ACL and RLS.
CREATE SCHEMA weshirt_site_private;
REVOKE ALL ON SCHEMA weshirt_site_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA weshirt_site_private TO service_role;

CREATE TABLE weshirt_site_private.entries (
  key text COLLATE "C" PRIMARY KEY CHECK (pg_catalog.octet_length(key) BETWEEN 1 AND 512),
  value jsonb NOT NULL CHECK (pg_catalog.octet_length(value::text) <= 33554432),
  expires_at timestamptz
);
CREATE INDEX site_store_expiry
  ON weshirt_site_private.entries (expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE weshirt_site_private.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE weshirt_site_private.entries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE weshirt_site_private.entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE weshirt_site_private.entries TO service_role;
CREATE POLICY site_store_service_only ON weshirt_site_private.entries TO service_role
  USING (true) WITH CHECK (true);

CREATE FUNCTION weshirt_site_private.require_service()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  -- CloudBase exposes RPC routes independently of the PostgreSQL EXECUTE grants.
  IF (COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role')
      IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'site_store_service_required';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION weshirt_site_private.require_service() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION weshirt_site_private.require_service() TO service_role;

CREATE FUNCTION public.weshirt_site_store_get(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_value jsonb;
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_key IS NULL OR pg_catalog.octet_length(p_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_key';
  END IF;
  SELECT value INTO v_value FROM weshirt_site_private.entries
    WHERE key = p_key AND (expires_at IS NULL OR expires_at > pg_catalog.statement_timestamp());
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result',
    CASE WHEN FOUND THEN pg_catalog.jsonb_build_object('found', true, 'value', v_value)
         ELSE pg_catalog.jsonb_build_object('found', false) END);
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_put(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_key IS NULL OR pg_catalog.octet_length(p_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_key';
  END IF;
  -- HTTP RPC decoders may translate an explicit JSON null to SQL NULL.
  INSERT INTO weshirt_site_private.entries (key, value)
    VALUES (p_key, COALESCE(p_value, 'null'::jsonb))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', true);
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_delete(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_key IS NULL OR pg_catalog.octet_length(p_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_key';
  END IF;
  DELETE FROM weshirt_site_private.entries WHERE key = p_key;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', true);
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_list(p_prefix text, p_after text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
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

  -- Check one additional row to distinguish a full final page from further work.
  -- The byte bound limits combined values, while the first individual row always
  -- fits in a page of its own so large records never stall traversal.
  WITH candidates AS (
    SELECT key, value
    FROM weshirt_site_private.entries
    WHERE key >= p_prefix
      AND (p_after IS NULL OR key > p_after)
      AND pg_catalog.starts_with(key, p_prefix)
      AND (expires_at IS NULL OR expires_at > pg_catalog.statement_timestamp())
    ORDER BY key
    LIMIT p_limit + 1
  ), sized AS (
    SELECT key, value,
      pg_catalog.row_number() OVER (ORDER BY key) AS position,
      pg_catalog.sum(pg_catalog.octet_length(pg_catalog.to_jsonb(key)::text)
        + pg_catalog.octet_length(value::text) + 64) OVER (ORDER BY key) AS total_bytes
    FROM candidates
  ), page AS (
    SELECT *, position <= p_limit AND (position = 1 OR total_bytes <= 393216) AS included
    FROM sized
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', key, 'value', value) ORDER BY key)
                  FILTER (WHERE included), '[]'::jsonb),
         CASE WHEN pg_catalog.bool_or(NOT included) THEN pg_catalog.max(key) FILTER (WHERE included) END
    INTO v_rows, v_next FROM page;

  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result',
    pg_catalog.jsonb_build_object('rows', v_rows, 'next', v_next));
END;
$function$;

CREATE FUNCTION public.weshirt_site_store_import(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
DECLARE
  v_size integer;
  v_inserted integer;
BEGIN
  PERFORM weshirt_site_private.require_service();
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_import';
  END IF;
  v_size := pg_catalog.jsonb_array_length(p_rows);
  IF v_size NOT BETWEEN 1 AND 256 OR pg_catalog.octet_length(p_rows::text) > 34603008 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_import';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS row(item)
    WHERE pg_catalog.jsonb_typeof(item) <> 'object'
       OR pg_catalog.jsonb_typeof(item -> 'key') IS DISTINCT FROM 'string'
       OR pg_catalog.octet_length(item ->> 'key') NOT BETWEEN 1 AND 512
       OR NOT (item ? 'value')
       OR pg_catalog.octet_length((item -> 'value')::text) > 33554432
       OR CASE pg_catalog.jsonb_typeof(item -> 'expiresAtMs')
            WHEN 'number' THEN NOT (item ->> 'expiresAtMs') ~ '^[0-9]{1,16}$'
              OR (item ->> 'expiresAtMs')::numeric > 8640000000000000
            WHEN 'null' THEN false
            ELSE item ? 'expiresAtMs'
          END
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS row(item)
    GROUP BY (item ->> 'key') COLLATE "C" HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'site_store_invalid_import';
  END IF;

  INSERT INTO weshirt_site_private.entries (key, value, expires_at)
    SELECT item ->> 'key', item -> 'value',
      pg_catalog.to_timestamp((item ->> 'expiresAtMs')::double precision / 1000)
    FROM pg_catalog.jsonb_array_elements(p_rows) AS row(item)
    ORDER BY (item ->> 'key') COLLATE "C"
    ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result',
    pg_catalog.jsonb_build_object('inserted', v_inserted, 'existing', v_size - v_inserted));
END;
$function$;

REVOKE ALL ON FUNCTION public.weshirt_site_store_get(text),
  public.weshirt_site_store_put(text, jsonb), public.weshirt_site_store_delete(text),
  public.weshirt_site_store_list(text, text, integer), public.weshirt_site_store_import(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weshirt_site_store_get(text),
  public.weshirt_site_store_put(text, jsonb), public.weshirt_site_store_delete(text),
  public.weshirt_site_store_list(text, text, integer), public.weshirt_site_store_import(jsonb)
  TO service_role;
