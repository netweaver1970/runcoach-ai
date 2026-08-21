/** Persistence for the Travel-mode itinerary (start offset + legs). Backed up via backup.ts. */
import * as FileSystem from 'expo-file-system';
import { TravelLeg } from './travelProjection';

export const TRAVEL_ITINERARY_FILE = `${FileSystem.documentDirectory}runcoach-travel-itinerary.json`;

export interface Itinerary { startInDays: number; legs: TravelLeg[] }

const DEFAULT: Itinerary = {
  startInDays: 23,   // ≈ mid-Sept from late Aug — user-adjustable
  legs: [
    { id: 'sg', place: 'Singapore', days: 6, climate: 'tropical' },
    { id: 'kr', place: 'Korea',     days: 8, climate: 'warm' },
  ],
};

export async function loadItinerary(): Promise<Itinerary> {
  try {
    const info = await FileSystem.getInfoAsync(TRAVEL_ITINERARY_FILE);
    if (!info.exists) return DEFAULT;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(TRAVEL_ITINERARY_FILE)) as Itinerary;
    if (parsed && Array.isArray(parsed.legs) && parsed.legs.length && typeof parsed.startInDays === 'number') return parsed;
    return DEFAULT;
  } catch { return DEFAULT; }
}

export async function saveItinerary(it: Itinerary): Promise<void> {
  try { await FileSystem.writeAsStringAsync(TRAVEL_ITINERARY_FILE, JSON.stringify(it)); } catch { /* ignore */ }
}
