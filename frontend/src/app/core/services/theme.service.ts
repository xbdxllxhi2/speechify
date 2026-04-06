import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { StorageService } from './storage.service';
import { ThemeMode } from '../models/document.model';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly storage = inject(StorageService);
  private mediaQuery: MediaQueryList | null = null;

  private readonly _themeMode = signal<ThemeMode>('light');
  private readonly _systemPrefersDark = signal(false);

  readonly themeMode = this._themeMode.asReadonly();

  // Computed: actual resolved theme (light or dark)
  readonly resolvedTheme = computed(() => {
    const mode = this._themeMode();
    if (mode === 'system') {
      return this._systemPrefersDark() ? 'dark' : 'light';
    }
    return mode;
  });

  readonly isDark = computed(() => this.resolvedTheme() === 'dark');

  constructor() {
    this.initSystemThemeListener();
    this.loadTheme();

    // Effect to apply theme changes
    effect(() => {
      this.applyTheme(this.resolvedTheme());
    });
  }

  private initSystemThemeListener(): void {
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._systemPrefersDark.set(this.mediaQuery.matches);

      // Listen for system theme changes
      this.mediaQuery.addEventListener('change', (e) => {
        this._systemPrefersDark.set(e.matches);
      });
    }
  }

  private async loadTheme(): Promise<void> {
    const settings = await this.storage.getSettings();
    this._themeMode.set(settings.theme);
  }

  async setTheme(mode: ThemeMode): Promise<void> {
    this._themeMode.set(mode);
    await this.storage.setSetting('theme', mode);
  }

  private applyTheme(theme: 'light' | 'dark'): void {
    const html = this.document.documentElement;

    if (theme === 'dark') {
      html.classList.add('dark');
      html.setAttribute('data-theme', 'dark');
    } else {
      html.classList.remove('dark');
      html.setAttribute('data-theme', 'light');
    }
  }
}
