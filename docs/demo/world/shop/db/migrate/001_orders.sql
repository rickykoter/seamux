CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
