-- Server-only mobile sessions. No environment identifiers or credentials.
-- Fail on existing names instead of replacing another component's objects.
CREATE SCHEMA weshirt_mobile_private;
REVOKE ALL ON SCHEMA weshirt_mobile_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA weshirt_mobile_private TO service_role;

CREATE TABLE weshirt_mobile_private.weshirt_mobile_sessions (
  key_digest text PRIMARY KEY CHECK (key_digest ~ '^[A-Za-z0-9_-]{43}$'),
  version uuid NOT NULL,
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX weshirt_mobile_sessions_expiry
  ON weshirt_mobile_private.weshirt_mobile_sessions (expires_at);
ALTER TABLE weshirt_mobile_private.weshirt_mobile_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE weshirt_mobile_private.weshirt_mobile_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE weshirt_mobile_private.weshirt_mobile_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE weshirt_mobile_private.weshirt_mobile_sessions TO service_role;
CREATE POLICY mobile_atomic_service_only
  ON weshirt_mobile_private.weshirt_mobile_sessions TO service_role
  USING (true) WITH CHECK (true);

CREATE FUNCTION public.weshirt_mobile_atomic_get(p_key_digest text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
DECLARE
  v_version uuid;
  v_value jsonb;
  v_now timestamptz;
BEGIN
  -- CloudBase currently exposes RPC endpoints even without GRANT EXECUTE.
  -- A signed server credential is mandatory in addition to table ACL and RLS.
  IF (COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role')
      IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'mobile_atomic_service_required';
  END IF;
  IF p_key_digest IS NULL OR p_key_digest !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'mobile_atomic_invalid_input';
  END IF;
  -- A transaction-scoped lock also covers absent/expired rows. Hash collisions
  -- only serialize unrelated keys; they cannot mix their stored values.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_key_digest)::bigint);
  v_now := pg_catalog.clock_timestamp();
  SELECT version, value INTO v_version, v_value
    FROM weshirt_mobile_private.weshirt_mobile_sessions
    WHERE key_digest = p_key_digest AND expires_at > v_now;
  RETURN pg_catalog.jsonb_build_object(
    'protocolVersion', 1, 'ok', true,
    'result', CASE WHEN FOUND THEN pg_catalog.jsonb_build_object('version', v_version::text, 'value', v_value) ELSE NULL END
  );
END;
$function$;

CREATE FUNCTION public.weshirt_mobile_atomic_cas(
  p_key_digest text,
  p_expected_version text,
  p_next_version uuid,
  p_value jsonb,
  p_expires_at_ms bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
DECLARE
  v_active_version text;
  v_now timestamptz;
  v_expires_at timestamptz;
BEGIN
  IF (COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role')
      IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'mobile_atomic_service_required';
  END IF;
  IF p_key_digest IS NULL OR p_key_digest !~ '^[A-Za-z0-9_-]{43}$'
      OR p_next_version IS NULL OR p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) <> 'object'
      OR pg_catalog.octet_length(p_value::text) > 65536 OR p_expires_at_ms IS NULL
      OR (p_expected_version IS NOT NULL AND pg_catalog.length(p_expected_version) > 80) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'mobile_atomic_invalid_input';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_key_digest)::bigint);
  v_now := pg_catalog.clock_timestamp();
  v_expires_at := pg_catalog.to_timestamp(p_expires_at_ms::double precision / 1000.0);
  IF v_expires_at <= v_now OR v_expires_at > v_now + interval '100 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'mobile_atomic_invalid_expiry';
  END IF;
  SELECT version::text INTO v_active_version
    FROM weshirt_mobile_private.weshirt_mobile_sessions
    WHERE key_digest = p_key_digest AND expires_at > v_now;
  IF v_active_version IS DISTINCT FROM p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', false);
  END IF;
  IF v_active_version = p_next_version::text THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'mobile_atomic_version_must_change';
  END IF;
  INSERT INTO weshirt_mobile_private.weshirt_mobile_sessions (key_digest, version, value, expires_at)
    VALUES (p_key_digest, p_next_version, p_value, v_expires_at)
    ON CONFLICT (key_digest) DO UPDATE SET
      version = EXCLUDED.version, value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
  RETURN pg_catalog.jsonb_build_object('protocolVersion', 1, 'ok', true, 'result', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.weshirt_mobile_atomic_get(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.weshirt_mobile_atomic_cas(text, text, uuid, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weshirt_mobile_atomic_get(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.weshirt_mobile_atomic_cas(text, text, uuid, jsonb, bigint) TO service_role;
