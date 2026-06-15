-- =====================================================================
-- AAA_Database :: 0100 :: Column encryption + blind indexing
-- Target: PostgreSQL 16+  (depends on 0001_foundation: pgcrypto + roles)
--
-- These helpers operate the encrypted columns defined in the domain
-- schemas (e.g. hr.employee.national_id_enc, hr.compensation.amount_enc,
-- tokenized bank fields). The application stores ciphertext (bytea) and
-- a separate deterministic "blind index" (bytea) for equality lookups.
--
-- KEY MANAGEMENT (critical):
--   * Keys are NEVER stored in the database.
--   * The app fetches keys from an external KMS / Vault and injects them
--     per transaction:
--         SET LOCAL app.enc_key          = '<data encryption key>';
--         SET LOCAL app.blind_index_key  = '<separate HMAC key>';
--   * encrypt/decrypt use one key; blind_index uses a SEPARATE key, so
--     compromise of one does not compromise the other.
--   * Functions fail CLOSED: if the key GUC is absent they raise, rather
--     than silently producing unusable/garbage data.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS sec;
COMMENT ON SCHEMA sec IS 'Security helpers: column encryption and blind indexing. Keys are supplied per-session from an external KMS and are never stored in the database.';

-- ---------------------------------------------------------------------
-- Encrypt a secret value (randomized -> ciphertext differs each call).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec.encrypt(plaintext text)
RETURNS bytea
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE k text;
BEGIN
    IF plaintext IS NULL THEN RETURN NULL; END IF;
    k := current_setting('app.enc_key', true);
    IF k IS NULL OR k = '' THEN
        RAISE EXCEPTION 'sec.encrypt: session key app.enc_key is not set (inject it from your KMS via SET LOCAL app.enc_key)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN pgp_sym_encrypt(plaintext, k);
END;
$$;

-- ---------------------------------------------------------------------
-- Decrypt a secret value.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec.decrypt(ciphertext bytea)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE k text;
BEGIN
    IF ciphertext IS NULL THEN RETURN NULL; END IF;
    k := current_setting('app.enc_key', true);
    IF k IS NULL OR k = '' THEN
        RAISE EXCEPTION 'sec.decrypt: session key app.enc_key is not set'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN pgp_sym_decrypt(ciphertext, k);
END;
$$;

-- ---------------------------------------------------------------------
-- Blind index: deterministic keyed hash for equality lookups on
-- encrypted data WITHOUT decryption. Store the result in a *_hash bytea
-- column (e.g. hr.employee.national_id_hash) at write time, then query:
--     WHERE national_id_hash = sec.blind_index('123-45-6789')
-- Normalizes case so lookups are case-insensitive (suitable for emails,
-- national IDs). Uses a SEPARATE key from encryption.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec.blind_index(value text)
RETURNS bytea
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE k text;
BEGIN
    IF value IS NULL THEN RETURN NULL; END IF;
    k := current_setting('app.blind_index_key', true);
    IF k IS NULL OR k = '' THEN
        RAISE EXCEPTION 'sec.blind_index: session key app.blind_index_key is not set'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN hmac(lower(value), k, 'sha256');
END;
$$;

-- ---------------------------------------------------------------------
-- Privileges: deny by default; encryption/decryption only to read-write
-- app role; blind-index to both (read-only needs it for lookups).
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION sec.encrypt(text)      FROM PUBLIC;
REVOKE ALL ON FUNCTION sec.decrypt(bytea)     FROM PUBLIC;
REVOKE ALL ON FUNCTION sec.blind_index(text)  FROM PUBLIC;

GRANT USAGE ON SCHEMA sec TO app_readwrite, app_readonly;
GRANT EXECUTE ON FUNCTION sec.encrypt(text)     TO app_readwrite;
GRANT EXECUTE ON FUNCTION sec.decrypt(bytea)    TO app_readwrite;
GRANT EXECUTE ON FUNCTION sec.blind_index(text) TO app_readwrite, app_readonly;

COMMENT ON FUNCTION sec.encrypt(text)     IS 'Encrypt plaintext with the per-session KMS key app.enc_key. Randomized output. Fails closed if key absent.';
COMMENT ON FUNCTION sec.decrypt(bytea)    IS 'Decrypt ciphertext with the per-session KMS key app.enc_key. Fails closed if key absent.';
COMMENT ON FUNCTION sec.blind_index(text) IS 'Deterministic HMAC (key app.blind_index_key) for equality lookup on encrypted columns without decryption. Case-normalized.';
