-- =====================================================================
-- AAA_Database :: 0070 :: allow a 'local' storage provider for agreements
-- Target: PostgreSQL 16+   Depends on 0050_legal.
--
-- The legal schema requires agreement files to live in object storage
-- (s3 / gcs / azure_blob). This adds 'local' for development and on-prem
-- filesystem storage so the upload feature works locally; production
-- deployments still use a cloud provider.
-- =====================================================================
ALTER TABLE legal.agreement_document DROP CONSTRAINT IF EXISTS ck_agreement_document_provider;
ALTER TABLE legal.agreement_document ADD  CONSTRAINT ck_agreement_document_provider
    CHECK (storage_provider = ANY (ARRAY['s3','gcs','azure_blob','local']));
