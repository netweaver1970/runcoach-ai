/**
 * WHERE am I lifting today → which equipment (Geert 2026-10-08): Merelbeke = home (Marcy machine + one cable stack +
 * adjustable dumbbells, no dual cable). Anywhere else, ask once per place: "Is there a gym?" → yes: gym; no → "Free
 * weights?" → yes: dumbbells; no → body weight only. Remembered per locality (StrengthStore.places); the answer sets
 * StrengthStore.here, which today's Daily custom, today's planned routine, a fresh session and the watch adapt to.
 */
import * as Location from 'expo-location';
import { Alert } from 'react-native';
import { loadStrength, updateStrength, KitId, KITS, HOME_PLACE, currentKit } from './strength';

async function detectLocality(): Promise<{ key: string; name: string } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    let pos = await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 });
    if (!pos) pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    if (!pos) return null;
    const geo = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
    const g = geo?.[0];
    const name = g?.city || g?.subregion || g?.district || g?.region;
    if (!name) return null;
    return { key: name.trim().toLowerCase(), name: name.trim() };
  } catch { return null; }
}

/** The two questions, as alerts. Resolves null when dismissed. */
export function askKit(placeName: string): Promise<KitId | null> {
  return new Promise(resolve => {
    Alert.alert(`📍 ${placeName}`, 'Strength today — is there a gym here?', [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(null) },
      { text: 'No', onPress: () => Alert.alert('Free weights?', 'Dumbbells (or kettlebells) available here?', [
          { text: 'No — body weight', onPress: () => resolve('bw') },
          { text: 'Yes', onPress: () => resolve('free') },
        ], { cancelable: true, onDismiss: () => resolve(null) }) },
      { text: 'Yes, a gym', onPress: () => resolve('gym') },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
}

/** Pick the kit for a place by hand ("change"). */
export function pickKit(placeName: string): Promise<KitId | null> {
  return new Promise(resolve => {
    Alert.alert(`📍 ${placeName}`, 'What can you train with here?', [
      ...(Object.keys(KITS) as KitId[]).map(k => ({ text: KITS[k].label, onPress: () => resolve(k) })),
      { text: 'Cancel', style: 'cancel' as const, onPress: () => resolve(null) },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
}

let checking: Promise<KitId | null> | null = null;
/**
 * Where am I → today's kit. Re-checks at most every 2 h (force = now). Unknown place → asks (once; remembered).
 * When the kit changes, today's Daily custom is recomposed and the plan re-tailored (its signature includes the kit).
 */
export function checkLocation(opts: { force?: boolean; ask?: (name: string) => Promise<KitId | null> } = {}): Promise<KitId | null> {
  if (checking) return checking;
  checking = (async () => {
    try {
      const st = await loadStrength();
      if (!opts.force && st.here && Date.now() - st.here.at < 2 * 3_600_000) return st.here.kit;
      const loc = await detectLocality();
      if (!loc) return st.here?.kit ?? null;
      // Merelbeke merged with Melle (2025) → the geocoder may say "Merelbeke-Melle"
      const isHome = loc.key.startsWith(HOME_PLACE);
      let kit: KitId | undefined = st.places?.[loc.key] ?? (isHome ? 'home' : undefined);
      if (!kit) {
        const a = await (opts.ask ?? askKit)(loc.name);
        if (!a) {
          // "Not now": don't ask again for 2 h (home kit meanwhile) — no nagging on every focus
          await updateStrength(s => ({ ...s, here: { place: loc.key, name: loc.name, kit: s.here?.place === loc.key ? s.here.kit : 'home', at: Date.now() } }));
          return null;
        }
        kit = a;
      }
      const k = kit;
      const changed = currentKit(st) !== k || st.here?.place !== loc.key;
      await updateStrength(s => ({ ...s, places: { ...(s.places ?? {}), [loc.key]: k }, here: { place: loc.key, name: loc.name, kit: k, at: Date.now() } }));
      if (changed) applyKitChange().catch(() => {});   // not awaited: never hold `checking` (and the screens) on a re-plan
      return k;
    } catch { return null; }
    finally { checking = null; }
  })();
  return checking;
}

/** Set the kit for the current place by hand. */
export async function setKitHere(kit: KitId): Promise<void> {
  const st = await loadStrength();
  // remember it for the place only when we KNOW where you are (a fresh check); otherwise it's just today's choice
  const fresh = !!st.here && Date.now() - st.here.at < 12 * 3_600_000;
  const place = fresh ? st.here!.place : 'unknown', name = fresh ? st.here!.name : 'Here';
  await updateStrength(s => ({ ...s, ...(fresh ? { places: { ...(s.places ?? {}), [place]: kit } } : {}), here: { place, name, kit, at: Date.now() } }));
  await applyKitChange();
}

async function applyKitChange(): Promise<void> {
  const { ensureDailyCustom, ensureStrengthPlan } = require('./strengthPlan') as typeof import('./strengthPlan');
  await ensureDailyCustom().catch(() => false);                 // its freshness check includes the kit → recomposes for it
  ensureStrengthPlan({ ai: true, force: true }).catch(() => null);   // today's tailoring for the new kit (queued after a running one)
  const { pushStrengthToWatch } = require('./watchStrength') as typeof import('./watchStrength');
  pushStrengthToWatch().catch(() => {});
}
