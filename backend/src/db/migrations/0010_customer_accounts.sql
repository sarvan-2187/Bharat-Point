-- ============================================================
-- 0010: customers can sign up and sign in.
--
-- A self-registered customer is a CUSTOMER user with one device key (the same
-- passkey sign-in as staff), linked one-to-one to their customers row. They
-- can only read their own transactions. Staff-seeded customers keep user_id
-- NULL and never sign in.
-- ============================================================

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('AGENT', 'ADMIN', 'BANK_OPERATOR', 'CUSTOMER'));

ALTER TABLE customers ADD COLUMN user_id UUID UNIQUE REFERENCES users(id);
