ALTER TABLE execution_intents
  ADD COLUMN IF NOT EXISTS order_revalidated_at timestamptz;
