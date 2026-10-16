ALTER TABLE records ADD COLUMN cost_center TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_records_cost_center ON records(cost_center);
CREATE INDEX IF NOT EXISTS idx_records_client_cost_destination
  ON records(client_name, cost_center, destination_code);
