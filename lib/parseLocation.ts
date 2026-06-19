// Parse a free-text "lat, lng" (or "lat lng") string into a point.
// Returns null if the text isn't a valid coordinate pair (caller should then
// fall back to geocoding).
export type Pt = { lat: number; lng: number };

export function parseCoordinates(text: string): Pt | null {
  const m = text
    .trim()
    .match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
