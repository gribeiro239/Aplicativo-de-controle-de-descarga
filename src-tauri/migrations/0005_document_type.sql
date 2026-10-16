ALTER TABLE records ADD COLUMN document_type TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_records_document_type ON records(document_type);
