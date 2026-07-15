// Prefix a root-absolute API/asset path with the app's deploy base (import.meta.env.BASE_URL).
// Root deploy (BASE_URL "/") returns the path unchanged (zero regression);
// subpath deploy (BASE_URL "/cad/") turns "/api/x" into "/cad/api/x".
export function apiUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return path;
  const base = import.meta.env.BASE_URL || "/";
  return base.replace(/\/+$/, "") + path;
}
