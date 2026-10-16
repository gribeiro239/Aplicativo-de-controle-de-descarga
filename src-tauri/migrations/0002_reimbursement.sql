ALTER TABLE records ADD COLUMN reimbursement TEXT NOT NULL DEFAULT 'not-informed';

CREATE INDEX IF NOT EXISTS idx_records_reimbursement ON records(reimbursement);
