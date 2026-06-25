/**
 * Weather service — current conditions at the runner's location.
 *
 * Flow: expo-location (precise GPS, "while using" permission) → Open-Meteo
 * (free, no API key). Everything degrades gracefully: any failure returns null
 * and the recommendation simply omits weather rather than breaking.
 */

import * as Location from 'expo-location';

export interface WeatherNow {
  tempC:      number;
  apparentC:  number;   // "feels like"
  humidity:   number;   // %
  windKmh:    number;
  code:       number;   // WMO weather code
  description: string;
  place?:     string;   // e.g. "Brussels"
}

// WMO weather interpretation codes → short description
const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail',
};

export function weatherDescription(code: number): string {
  return WMO[code] ?? 'Unknown';
}

let lastFetch: { at: number; data: WeatherNow } | null = null;
const CACHE_MS = 30 * 60_000; // 30 min — conditions don't change minute-to-minute

// The last GPS-geocoded place (e.g. "Merelbeke"), or undefined until weather is fetched.
// Use this for location context — NOT the IANA timezone, which is "Brussels" for all of Belgium.
export function getCachedPlace(): string | undefined {
  return lastFetch?.data.place;
}

/**
 * Get current weather at the device location.
 * Returns null if permission is denied or anything fails (never throws).
 */
export async function getLocalWeather(): Promise<WeatherNow | null> {
  // Serve a recent cached value to avoid hammering GPS + API on every refresh
  if (lastFetch && Date.now() - lastFetch.at < CACHE_MS) return lastFetch.data;

  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    // Use a last-known fix ONLY if it's recent (<10 min) — otherwise it can serve a
    // stale location from a previous city. Fall back to a fresh GPS fix.
    let pos = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 });
    if (!pos) pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    if (!pos) return null;

    const { latitude, longitude } = pos.coords;

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(3)}` +
      `&longitude=${longitude.toFixed(3)}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&wind_speed_unit=kmh&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const c = json.current;
    if (!c) return null;

    // Reverse-geocode for a friendly place name (best-effort)
    let place: string | undefined;
    try {
      const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
      place = geo[0]?.city ?? geo[0]?.subregion ?? geo[0]?.region ?? undefined;
    } catch { /* ignore */ }

    const data: WeatherNow = {
      tempC:       Math.round(c.temperature_2m),
      apparentC:   Math.round(c.apparent_temperature),
      humidity:    Math.round(c.relative_humidity_2m),
      windKmh:     Math.round(c.wind_speed_10m),
      code:        c.weather_code,
      description: weatherDescription(c.weather_code),
      place,
    };
    lastFetch = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

/** Compact one-line summary for prompts, e.g. "12°C (feels 9°C), Light rain, wind 18km/h, 80% RH". */
export function weatherSummary(w: WeatherNow): string {
  return `${w.tempC}°C (feels ${w.apparentC}°C), ${w.description}, wind ${w.windKmh}km/h, ${w.humidity}% RH`;
}
