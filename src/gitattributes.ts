/**
 * A `.gitattributes` line that sets `merge=union` for exactly `file` (a path from the repository root). The pattern is
 * anchored with a leading `/` so a root file does not also match same-named files in subdirectories, glob characters
 * are escaped so they match literally, and a path with whitespace, quotes or control characters is C-quoted, since an
 * unquoted space would end the pattern.
 */
export function unionMergeLine(file: string): string {
  const pattern = `/${file.replace(/[\\*?[\]]/g, "\\$&")}`;
  if (!/[\s"\x00-\x1f\x7f]/.test(file)) return `${pattern} merge=union`;
  const escapes: Record<string, string> = {
    "\\": "\\\\",
    '"': '\\"',
    "\t": "\\t",
    "\n": "\\n",
    "\r": "\\r",
  };
  const quoted = pattern.replace(
    /[\\"\x00-\x1f\x7f]/g,
    (char) =>
      escapes[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return `"${quoted}" merge=union`;
}
