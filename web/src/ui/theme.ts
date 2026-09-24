import { ChangeNotifier } from '../core/notifier';
import { StorageKeys, readString, removeKey, writeString } from '../core/storage';

/**
 * Port of `ThemeProvider` from `lib/core/config.dart`.
 *
 * In the Android source this provider was wired into `MaterialApp.theme` but no
 * control ever called `toggle()`, so the app was permanently light. The web app
 * keeps the same provider and finally exposes the switch (AppBar).
 */
export class ThemeController extends ChangeNotifier {
  private darkValue: boolean;

  constructor() {
    super();
    const stored = readString(StorageKeys.theme);
    if (stored === 'dark') this.darkValue = true;
    else if (stored === 'light') this.darkValue = false;
    else this.darkValue = prefersDark();
  }

  get dark(): boolean {
    return this.darkValue;
  }

  toggle(): void {
    this.darkValue = !this.darkValue;
    writeString(StorageKeys.theme, this.darkValue ? 'dark' : 'light');
    this.notify();
  }

  /** 'system' clears the explicit choice and falls back to the OS preference. */
  useSystemPreference(): void {
    removeKey(StorageKeys.theme);
    this.darkValue = prefersDark();
    this.notify();
  }
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
