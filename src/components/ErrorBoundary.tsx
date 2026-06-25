import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Appearance } from 'react-native';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * Catches render errors anywhere below it and shows a readable fallback (message +
 * stack + "Try again") instead of a blank screen. Must be a class component — that's
 * the only way React exposes getDerivedStateFromError / componentDidCatch. Uses
 * Appearance (not the theme context) for colours so it still renders if theming throws.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Render error caught by ErrorBoundary:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const dark = Appearance.getColorScheme() !== 'light';
    const bg   = dark ? '#08080A' : '#E7E8EE';
    const card = dark ? '#1E1F26' : '#FFFFFF';
    const text = dark ? '#F5F5F7' : '#16161A';
    const sub  = dark ? '#A1A6B0' : '#5B616B';

    return (
      <View style={{ flex: 1, backgroundColor: bg, padding: 20, paddingTop: 80, justifyContent: 'center' }}>
        <View style={{ backgroundColor: card, borderRadius: 14, padding: 20 }}>
          <Text style={{ fontSize: 40, textAlign: 'center', marginBottom: 8 }}>😵</Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: text, textAlign: 'center', marginBottom: 6 }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 13, color: sub, textAlign: 'center', marginBottom: 14 }}>
            A screen hit an error and was caught instead of going blank. Tap Try again, or restart the app.
          </Text>
          <ScrollView style={{ maxHeight: 220, marginBottom: 14 }}>
            <Text style={{ fontSize: 12, color: sub, fontFamily: 'Menlo' }} selectable>
              {error.message}{error.stack ? `\n\n${error.stack}` : ''}
            </Text>
          </ScrollView>
          <TouchableOpacity
            onPress={this.reset}
            style={{ backgroundColor: '#FF6B35', borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Try again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
}
