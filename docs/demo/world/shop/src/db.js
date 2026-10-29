// A tiny in-memory store standing in for the database.
const tables = { orders: [] }

export function table(name) {
  if (!tables[name]) tables[name] = []
  return tables[name]
}
