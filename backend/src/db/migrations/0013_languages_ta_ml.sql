ALTER TABLE customers DROP CONSTRAINT customers_preferred_language_check;
ALTER TABLE customers ADD CONSTRAINT customers_preferred_language_check
  CHECK (preferred_language IN ('en', 'hi', 'te', 'ta', 'ml'));
