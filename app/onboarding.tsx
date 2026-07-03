// Welcome / guided setup wizard. Runs on first launch (redirect from the home) and is re-runnable from
// Settings. Every step is skippable and the whole flow abortable via the ✕ — Finish OR abort both mark
// onboarding done and go home, leaving the app in a working state (all skipped items keep their defaults).
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Switch, Alert, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { requestPermissions, resolveBodyMassKg } from '../src/services/healthkit';
import {
  saveBodyMassKg, getUserMaxHr, setUserMaxHr, getUserProfile, setUserProfile, estimateMaxHr,
  setOnboardingDone, UserProfile,
} from '../src/services/claude';
import { saveLLMConfig, validateLLMKey, loadLLMConfig, LLMProvider } from '../src/services/llm';
import { setPlanMode, setRaceConfig } from '../src/services/racePlan';
import { upsertKnowledge } from '../src/services/coachFiles';

const STEPS = ['Welcome', 'Apple Health', 'About you', 'Your goal', 'Your week', 'AI coaching', 'Cloud', 'All set'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']; // Mon=0

// Build a "Preferred Weekly Structure" markdown (the format parseWeeklyTemplate reads) from the wizard.
function buildScheduleMd(runDays: number, longDayIdx: number, includeSpeed: boolean): string {
  const kind: string[] = Array(7).fill('rest');
  kind[longDayIdx] = 'Long';
  let placed = 1;
  const order = [1, 3, 0, 2, 5, 4, 6]; // Tue,Thu,Mon,Wed,Sat,Fri,Sun — spread quality/easy
  if (includeSpeed) {
    let q = 0;
    for (const i of order) {
      if (placed >= runDays || q >= 2) break;
      if (kind[i] !== 'rest') continue;
      kind[i] = q === 0 ? 'Intervals' : 'Tempo'; placed++; q++;
    }
  }
  for (const i of order) { if (placed >= runDays) break; if (kind[i] !== 'rest') continue; kind[i] = 'Easy Z2'; placed++; }
  const lines = DAY_NAMES.map((n, i) => `${n}: ${kind[i] === 'rest' ? 'recovery or rest' : kind[i]}`);
  return `# Preferred Weekly Structure\n\nYour running week (edit any time). One long run, quality = intervals/tempo, easy fills the rest; other days recover.\n\n${lines.join('\n')}\n`;
}

export default function OnboardingScreen() {
  const router = useRouter();
  const { c, mode } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [step, setStep] = useState(0);

  // step 1 — health
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthOn, setHealthOn] = useState<boolean | null>(null);
  // step 2 — about you
  const [age, setAge] = useState('');
  const [sex, setSex] = useState<'M' | 'F' | ''>('');
  const [weight, setWeight] = useState('');
  const [maxHr, setMaxHr] = useState('');
  // step 3 — goal
  const [race, setRace] = useState(false);
  const [raceDateObj, setRaceDateObj] = useState<Date>(() => { const d = new Date(); d.setDate(d.getDate() + 56); d.setHours(0, 0, 0, 0); return d; });
  const [raceDist, setRaceDist] = useState('10');
  const [goalH, setGoalH] = useState(0);
  const [goalM, setGoalM] = useState(0);
  const [goalS, setGoalS] = useState(0);
  // step 4 — week
  const [runDays, setRunDays] = useState(4);
  const [longDay, setLongDay] = useState(5); // Sat
  const [speed, setSpeed] = useState(true);
  // step 5 — AI key
  const [provider, setProvider] = useState<LLMProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyOk, setKeyOk] = useState<boolean | null>(null);

  useEffect(() => {
    resolveBodyMassKg().then(kg => { if (kg) setWeight(String(Math.round(kg))); }).catch(() => {});
    getUserMaxHr().then(v => { if (v > 0) setMaxHr(String(v)); }).catch(() => {});
    getUserProfile().then((p: UserProfile) => { if (p.age) setAge(String(p.age)); if (p.sex) setSex(p.sex); }).catch(() => {});
    loadLLMConfig().then(cfg => setProvider(cfg.provider || 'anthropic')).catch(() => {});
  }, []);

  const finishAndGo = async () => { await setOnboardingDone(true); router.replace('/'); };

  // Persist the current step's data when leaving it forward (Continue). Skip leaves defaults untouched.
  const saveStep = async (stepIndex: number) => {
    if (stepIndex === 2) {
      const a = parseInt(age, 10); const w = parseInt(weight, 10); const mh = parseInt(maxHr, 10);
      if (!isNaN(w) && w >= 30 && w <= 250) await saveBodyMassKg(w);
      if (!isNaN(mh) && mh >= 120 && mh <= 220) await setUserMaxHr(mh);
      await setUserProfile({ age: !isNaN(a) && a > 0 && a < 120 ? a : undefined, sex });
    } else if (stepIndex === 3) {
      await setPlanMode(race ? 'race' : 'leisure');
      if (race) {
        const p = (n: number) => String(n).padStart(2, '0');
        await setRaceConfig({
          date: `${raceDateObj.getFullYear()}-${p(raceDateObj.getMonth() + 1)}-${p(raceDateObj.getDate())}`,
          distanceKm: parseFloat(raceDist) || 10, goalTimeSec: goalH * 3600 + goalM * 60 + goalS,
        });
      }
    } else if (stepIndex === 4) {
      await upsertKnowledge('running-schedule', 'Weekly Schedule', 'Preferred structured running week', buildScheduleMd(runDays, longDay, speed));
    }
  };

  const next = async () => { await saveStep(step).catch(() => {}); setStep(s => Math.min(STEPS.length - 1, s + 1)); };
  const skip = () => setStep(s => Math.min(STEPS.length - 1, s + 1)); // skip = advance without saving (keep defaults)
  const back = () => setStep(s => Math.max(0, s - 1));

  const connectHealth = async () => {
    setHealthBusy(true);
    try { const ok = await requestPermissions(); setHealthOn(ok); } catch { setHealthOn(false); } finally { setHealthBusy(false); }
  };
  const onAgeBlur = () => { const a = parseInt(age, 10); if (!isNaN(a) && a > 0 && a < 120 && !maxHr) setMaxHr(String(estimateMaxHr(a))); };
  const verifyKey = async () => {
    if (!apiKey.trim()) return;
    setKeyBusy(true); setKeyOk(null);
    try {
      const r = await validateLLMKey(provider, apiKey.trim());
      if (r.valid) { await saveLLMConfig(provider, { apiKey: apiKey.trim() }); setKeyOk(true); }
      else { setKeyOk(false); Alert.alert('Key not accepted', r.error || 'Could not validate the key.'); }
    } catch { setKeyOk(false); } finally { setKeyBusy(false); }
  };

  const Body = () => {
    switch (step) {
      case 0: return (
        <View style={s.center}>
          <Text style={s.emoji}>🏃‍♂️</Text>
          <Text style={s.h1}>Welcome to RunCoach AI</Text>
          <Text style={s.p}>Your personal running coach — it reads your Apple Health data and builds a plan that adapts to your recovery, your goals and the weather.</Text>
          <Text style={s.p}>Let's set you up. It takes about 2 minutes, and you can skip anything and change it later in Settings.</Text>
        </View>
      );
      case 1: return (
        <View style={s.center}>
          <Text style={s.emoji}>❤️</Text>
          <Text style={s.h1}>Connect Apple Health</Text>
          <Text style={s.p}>The coach reads your runs, heart rate, HRV, sleep and VO₂max from Apple Health. Nothing leaves your phone.</Text>
          <TouchableOpacity style={[s.primaryBtn, healthOn && s.primaryBtnDone]} onPress={connectHealth} disabled={healthBusy}>
            {healthBusy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>{healthOn ? '✓ Connected' : 'Connect Health'}</Text>}
          </TouchableOpacity>
          {healthOn === false ? <Text style={s.warn}>Not granted — you can enable it later in iOS Settings → Privacy → Health. The app needs it to see your data.</Text> : null}
        </View>
      );
      case 2: return (
        <View>
          <Text style={s.h1}>About you</Text>
          <Text style={s.p}>Used to tailor your zones and load. All optional.</Text>
          <Text style={s.label}>Age</Text>
          <View style={s.rowWrap}>
            <TextInput style={[s.input, { width: 90 }]} value={age} onChangeText={setAge} onBlur={onAgeBlur} keyboardType="number-pad" placeholder="—" placeholderTextColor={c.textFaint} returnKeyType="done" />
            <Text style={s.unit}>years</Text>
          </View>
          <Text style={s.label}>Sex</Text>
          <View style={s.seg}>
            {(['M', 'F'] as const).map(x => (
              <TouchableOpacity key={x} style={[s.segItem, sex === x && s.segItemOn]} onPress={() => setSex(sex === x ? '' : x)}>
                <Text style={[s.segText, sex === x && s.segTextOn]}>{x === 'M' ? 'Male' : 'Female'}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.label}>Body weight</Text>
          <View style={s.rowWrap}>
            <TextInput style={[s.input, { width: 90 }]} value={weight} onChangeText={setWeight} keyboardType="decimal-pad" placeholder="70" placeholderTextColor={c.textFaint} returnKeyType="done" />
            <Text style={s.unit}>kg</Text>
          </View>
          <Text style={s.label}>Max heart rate</Text>
          <View style={s.rowWrap}>
            <TextInput style={[s.input, { width: 90 }]} value={maxHr} onChangeText={setMaxHr} keyboardType="number-pad" placeholder="—" placeholderTextColor={c.textFaint} returnKeyType="done" />
            <Text style={s.unit}>bpm</Text>
          </View>
          <Text style={s.hintSmall}>Enter your age and we'll estimate max HR (Tanaka) — override with a real measured value if you have one.</Text>
        </View>
      );
      case 3: return (
        <View>
          <Text style={s.h1}>Your goal</Text>
          <View style={s.seg}>
            <TouchableOpacity style={[s.segItem, !race && s.segItemOn]} onPress={() => setRace(false)}><Text style={[s.segText, !race && s.segTextOn]}>Leisure build-up</Text></TouchableOpacity>
            <TouchableOpacity style={[s.segItem, race && s.segItemOn]} onPress={() => setRace(true)}><Text style={[s.segText, race && s.segTextOn]}>Race prep</Text></TouchableOpacity>
          </View>
          <Text style={s.hintSmall}>{race ? 'The coach builds a periodized plan toward your race (base→build→peak→taper).' : 'Sustainable build-up with periodized build/deload cycles.'}</Text>
          {race ? (
            <View style={{ marginTop: 8 }}>
              <View style={s.rowWrap}>
                <Text style={[s.label, { width: 96, marginTop: 0 }]}>Race date</Text>
                <DateTimePicker value={raceDateObj} mode="date" display="compact" minimumDate={new Date()} onChange={(_e, d) => { if (d) setRaceDateObj(d); }} themeVariant={mode === 'dark' ? 'dark' : 'light'} />
              </View>
              <View style={s.rowWrap}>
                <Text style={[s.label, { width: 96, marginTop: 0 }]}>Distance</Text>
                <TextInput style={[s.input, { width: 82, textAlign: 'center' }]} value={raceDist} onChangeText={setRaceDist} keyboardType="decimal-pad" placeholder="10" placeholderTextColor={c.textFaint} />
                <Text style={s.unit}>km</Text>
              </View>
              <Text style={[s.label]}>Goal time (0:00:00 = none)</Text>
              <View style={{ flexDirection: 'row' }}>
                {([[goalH, setGoalH, 10, 'h'], [goalM, setGoalM, 60, 'm'], [goalS, setGoalS, 60, 's']] as const).map(([val, setter, len, u], idx) => (
                  <Picker key={idx} style={{ flex: 1 }} itemStyle={{ fontSize: 20, height: 120, color: c.text }} selectedValue={val} onValueChange={(v) => setter(Number(v))}>
                    {Array.from({ length: len }, (_, i) => <Picker.Item key={i} label={`${i} ${u}`} value={i} color={c.text} />)}
                  </Picker>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      );
      case 4: return (
        <View>
          <Text style={s.h1}>Your week</Text>
          <Text style={s.p}>Roughly how you like to run. We'll seed a schedule you can edit later.</Text>
          <Text style={s.label}>Run days per week: {runDays}</Text>
          <View style={s.seg}>
            {[3, 4, 5, 6].map(n => (
              <TouchableOpacity key={n} style={[s.segItem, runDays === n && s.segItemOn]} onPress={() => setRunDays(n)}><Text style={[s.segText, runDays === n && s.segTextOn]}>{n}</Text></TouchableOpacity>
            ))}
          </View>
          <Text style={s.label}>Long-run day</Text>
          <Picker selectedValue={longDay} onValueChange={(v) => setLongDay(Number(v))} itemStyle={{ fontSize: 18, height: 130, color: c.text }}>
            {DAY_NAMES.map((d, i) => <Picker.Item key={i} label={d} value={i} color={c.text} />)}
          </Picker>
          <View style={[s.rowWrap, { justifyContent: 'space-between', marginTop: 4 }]}>
            <Text style={s.label}>Include speed work (intervals + tempo)</Text>
            <Switch value={speed} onValueChange={setSpeed} trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack} thumbColor="#fff" />
          </View>
        </View>
      );
      case 5: return (
        <View>
          <Text style={s.h1}>AI coaching (optional)</Text>
          <Text style={s.p}>Add an API key to unlock the AI coach, chat, run analysis and race planning. The app works fully without it — just say skip.</Text>
          <View style={s.seg}>
            {(['anthropic', 'openai'] as const).map(pv => (
              <TouchableOpacity key={pv} style={[s.segItem, provider === pv && s.segItemOn]} onPress={() => setProvider(pv)}><Text style={[s.segText, provider === pv && s.segTextOn]}>{pv === 'anthropic' ? 'Anthropic' : 'OpenAI'}</Text></TouchableOpacity>
            ))}
          </View>
          <TextInput style={[s.input, { marginTop: 10 }]} value={apiKey} onChangeText={t => { setApiKey(t); setKeyOk(null); }} placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} placeholderTextColor={c.textFaint} autoCapitalize="none" autoCorrect={false} secureTextEntry />
          <TouchableOpacity style={[s.primaryBtn, keyOk && s.primaryBtnDone]} onPress={verifyKey} disabled={keyBusy || !apiKey.trim()}>
            {keyBusy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>{keyOk ? '✓ Verified & saved' : 'Verify & save key'}</Text>}
          </TouchableOpacity>
          {keyOk === false ? <Text style={s.warn}>Couldn't verify that key — check it or skip for now.</Text> : null}
        </View>
      );
      case 6: return (
        <View style={s.center}>
          <Text style={s.emoji}>☁️</Text>
          <Text style={s.h1}>Working with a coach?</Text>
          <Text style={s.p}>If a human coach uses RunCoach AI, you can link accounts to sync your data and receive their prescriptions. Optional — most runners skip this.</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push('/account' as any)}><Text style={s.primaryBtnText}>Set up cloud account</Text></TouchableOpacity>
        </View>
      );
      default: return (
        <View style={s.center}>
          <Text style={s.emoji}>✅</Text>
          <Text style={s.h1}>You're all set</Text>
          <Text style={s.p}>Your first plan is being prepared from your Apple Health history. Everything here is editable any time in Settings — including re-running this setup.</Text>
        </View>
      );
    }
  };

  const isLast = step === STEPS.length - 1;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <View style={s.topBar}>
        <View style={s.dots}>
          {STEPS.map((_, i) => <View key={i} style={[s.dot, i === step && s.dotOn, i < step && s.dotDone]} />)}
        </View>
        <TouchableOpacity onPress={finishAndGo} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Text style={s.exit}>✕</Text></TouchableOpacity>
      </View>
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Body />
      </ScrollView>
      <View style={s.footer}>
        {step > 0 ? <TouchableOpacity onPress={back}><Text style={s.footLink}>Back</Text></TouchableOpacity> : <View style={{ width: 44 }} />}
        {isLast
          ? <TouchableOpacity style={s.nextBtn} onPress={finishAndGo}><Text style={s.nextText}>Finish</Text></TouchableOpacity>
          : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
              <TouchableOpacity onPress={skip}><Text style={s.footLink}>{step === 0 ? 'Skip setup' : 'Skip'}</Text></TouchableOpacity>
              <TouchableOpacity style={s.nextBtn} onPress={next}><Text style={s.nextText}>{step === 0 ? 'Get started' : 'Continue'}</Text></TouchableOpacity>
            </View>
          )}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4 },
  dots: { flexDirection: 'row', gap: 6, flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.surfaceAlt },
  dotOn: { backgroundColor: c.accent, width: 20 },
  dotDone: { backgroundColor: c.accent },
  exit: { fontSize: 20, color: c.textFaint, paddingLeft: 12, fontWeight: '600' as const },
  content: { padding: 24, paddingTop: 12, flexGrow: 1, justifyContent: 'center' as const },
  center: { alignItems: 'center' as const },
  emoji: { fontSize: 56, marginBottom: 16 },
  h1: { fontSize: 26, fontWeight: '800' as const, color: c.text, marginBottom: 10, textAlign: 'center' as const },
  p: { fontSize: 15.5, lineHeight: 22, color: c.textSub, marginBottom: 12, textAlign: 'center' as const },
  label: { fontSize: 14, fontWeight: '700' as const, color: c.text, marginTop: 16, marginBottom: 6 },
  hintSmall: { fontSize: 12.5, color: c.textFaint, marginTop: 8, lineHeight: 18 },
  rowWrap: { flexDirection: 'row', alignItems: 'center' as const, gap: 8 },
  input: { backgroundColor: c.surfaceAlt, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: c.text },
  unit: { fontSize: 15, color: c.textSub, fontWeight: '600' as const },
  seg: { flexDirection: 'row', gap: 8, marginTop: 4 },
  segItem: { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 10, paddingVertical: 12, alignItems: 'center' as const },
  segItemOn: { backgroundColor: c.accent },
  segText: { fontSize: 15, fontWeight: '700' as const, color: c.text },
  segTextOn: { color: '#fff' },
  warn: { fontSize: 13, color: '#e67e22', marginTop: 12, textAlign: 'center' as const, lineHeight: 19 },
  primaryBtn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 15, paddingHorizontal: 24, alignItems: 'center' as const, marginTop: 16, minWidth: 200 },
  primaryBtnDone: { backgroundColor: '#27ae60' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' as const },
  footer: { flexDirection: 'row', alignItems: 'center' as const, justifyContent: 'space-between', paddingHorizontal: 22, paddingVertical: 14, borderTopWidth: 1, borderTopColor: c.surfaceAlt },
  footLink: { fontSize: 16, color: c.textSub, fontWeight: '600' as const },
  nextBtn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28 },
  nextText: { color: '#fff', fontSize: 16, fontWeight: '800' as const },
});
