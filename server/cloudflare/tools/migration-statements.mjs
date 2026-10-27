// Trigger migrations use explicit separators so BEGIN/END bodies remain intact.
export function migrationStatements(sql) {
  const parts=sql.includes('-- statement-break') ? sql.split(/-- statement-break\s*\r?\n/)
    : sql.replace(/--[^\n]*/g,'').split(';');
  return parts.map(s=>s.replace(/--[^\n]*/g,'').trim()).filter(Boolean);
}
