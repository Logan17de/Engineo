CREATE TABLE auth_rate_limits (
  key_sha256 char(64) PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits (expires_at);
