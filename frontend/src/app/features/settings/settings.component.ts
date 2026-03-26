import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { Select } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';

import { StorageService } from '../../core/services/storage.service';
import { ApiService } from '../../core/services/api.service';
import { Voice, VoiceOption, AppSettings, DEFAULT_SETTINGS } from '../../core/models/document.model';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    Select,
    ToastModule,
    ToggleSwitch,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  private readonly storage = inject(StorageService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);

  voices = signal<VoiceOption[]>([]);
  selectedVoice = signal<Voice>('nova');
  playbackSpeed = signal(1.0);
  autoPlay = signal(true);
  highlightMode = signal<'sentence' | 'word'>('sentence');

  storageStats = signal<{ documentsCount: number; audioCacheSize: number }>({
    documentsCount: 0,
    audioCacheSize: 0,
  });

  isClearing = signal(false);

  speedOptions = [
    { label: '0.5x', value: 0.5 },
    { label: '0.75x', value: 0.75 },
    { label: '1x', value: 1.0 },
    { label: '1.25x', value: 1.25 },
    { label: '1.5x', value: 1.5 },
    { label: '2x', value: 2.0 },
  ];

  highlightOptions = [
    { label: 'Sentence', value: 'sentence' },
    { label: 'Word', value: 'word' },
  ];

  async ngOnInit(): Promise<void> {
    await this.loadVoices();
    await this.loadSettings();
    await this.loadStorageStats();
  }

  private async loadVoices(): Promise<void> {
    try {
      const voices = await this.api.getVoices().toPromise();
      this.voices.set(voices || []);
    } catch {
      this.voices.set([
        { id: 'alloy', name: 'Alloy', description: 'Neutral and balanced' },
        { id: 'echo', name: 'Echo', description: 'Warm and conversational' },
        { id: 'fable', name: 'Fable', description: 'Expressive and dynamic' },
        { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative' },
        { id: 'nova', name: 'Nova', description: 'Friendly and upbeat' },
        { id: 'shimmer', name: 'Shimmer', description: 'Clear and gentle' },
      ]);
    }
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.storage.getSettings();
    this.selectedVoice.set(settings.voice);
    this.playbackSpeed.set(settings.speed);
    this.autoPlay.set(settings.autoPlay);
    this.highlightMode.set(settings.highlightMode);
  }

  private async loadStorageStats(): Promise<void> {
    const stats = await this.storage.getStorageStats();
    this.storageStats.set(stats);
  }

  goBack(): void {
    this.router.navigate(['/library']);
  }

  async onVoiceChange(voice: Voice): Promise<void> {
    this.selectedVoice.set(voice);
    await this.storage.setSetting('voice', voice);
    this.showSaved();
  }

  async onSpeedChange(speed: number): Promise<void> {
    this.playbackSpeed.set(speed);
    await this.storage.setSetting('speed', speed);
    this.showSaved();
  }

  async onAutoPlayChange(enabled: boolean): Promise<void> {
    this.autoPlay.set(enabled);
    await this.storage.setSetting('autoPlay', enabled);
    this.showSaved();
  }

  async onHighlightModeChange(mode: 'sentence' | 'word'): Promise<void> {
    this.highlightMode.set(mode);
    await this.storage.setSetting('highlightMode', mode);
    this.showSaved();
  }

  confirmClearCache(event: Event): void {
    this.confirmationService.confirm({
      target: event.target as EventTarget,
      message: 'Clear all cached audio? Documents will be kept but audio will need to be regenerated.',
      header: 'Clear Audio Cache',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Clear',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.clearCache(),
    });
  }

  async clearCache(): Promise<void> {
    this.isClearing.set(true);
    try {
      await this.storage.clearAudioCache();
      await this.loadStorageStats();
      this.messageService.add({
        severity: 'success',
        summary: 'Cache Cleared',
        detail: 'Audio cache has been cleared',
      });
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to clear cache',
      });
    } finally {
      this.isClearing.set(false);
    }
  }

  async resetSettings(): Promise<void> {
    await this.storage.saveSettings(DEFAULT_SETTINGS);
    await this.loadSettings();
    this.showSaved();
  }

  private showSaved(): void {
    this.messageService.add({
      severity: 'success',
      summary: 'Saved',
      detail: 'Settings updated',
      life: 1500,
    });
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
