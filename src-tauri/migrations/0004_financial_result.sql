ALTER TABLE records ADD COLUMN received_value REAL;
ALTER TABLE records ADD COLUMN financial_status TEXT NOT NULL DEFAULT 'not-informed';

CREATE INDEX IF NOT EXISTS idx_records_financial_status ON records(financial_status);
