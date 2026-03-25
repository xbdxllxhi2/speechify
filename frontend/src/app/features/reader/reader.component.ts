import { Component, inject, signal, computed, OnInit, OnDestroy, input } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { ButtonModule } from 'primeng/button';
import { SliderModule } from 'primeng/slider';
import { Select } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { Tooltip } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';

import { StorageService } from '../../core/services/storage.service';
import { AudioService } from '../../core/services/audio.service';
import { ApiService } from '../../core/services/api.service';
import {
  StoredDocument,
  Chapter,
  Paragraph,
  Voice,
  VoiceOption,
} from '../../core/models/document.model';

@Component({
  selector: 'app-reader',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    SliderModule,
    Select,
    ToastModule,
    Tooltip,
  ],
  providers: [MessageService],
  templateUrl: './reader.component.html',
})
export class ReaderComponent implements OnInit, OnDestroy {
  readonly id = input.required<string>();

  private readonly storage = inject(StorageService);
  private readonly audioService = inject(AudioService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly messageService = inject(MessageService);
  private playbackEndedSub?: Subscription;
  private prefetchSub?: Subscription;

  document = signal<StoredDocument | null>(null);
  currentChapterIndex = signal(0);
  currentParagraphIndex = signal(0);
  voices = signal<VoiceOption[]>([]);
  selectedVoice = signal<Voice>('nova');
  playbackSpeed = signal(1.0);
  continuousMode = signal(true);

  // Audio state from service
  isPlaying = this.audioService.isPlaying;
  isLoading = this.audioService.isLoading;
  currentTime = this.audioService.currentTime;
  duration = this.audioService.duration;
  currentSentenceId = this.audioService.currentSentenceId;

  currentChapter = computed(() => {
    const doc = this.document();
    if (!doc) return null;
    return doc.chapters[this.currentChapterIndex()] || null;
  });

  currentParagraph = computed(() => {
    const chapter = this.currentChapter();
    if (!chapter) return null;
    return chapter.paragraphs[this.currentParagraphIndex()] || null;
  });

  progressPercent = computed(() => {
    const dur = this.duration();
    if (dur === 0) return 0;
    return Math.round((this.currentTime() / dur) * 100);
  });

  speedOptions = [
    { label: '0.5x', value: 0.5 },
    { label: '0.75x', value: 0.75 },
    { label: '1x', value: 1.0 },
    { label: '1.25x', value: 1.25 },
    { label: '1.5x', value: 1.5 },
    { label: '2x', value: 2.0 },
  ];

  async ngOnInit(): Promise<void> {
    await this.loadDocument();
    await this.loadVoices();
    await this.loadSettings();

    // Subscribe to playback ended for continuous mode
    this.playbackEndedSub = this.audioService.playbackEnded$.subscribe(() => {
      if (this.continuousMode()) {
        this.playNextParagraphAuto();
      }
    });

    // Subscribe to prefetch requests
    this.prefetchSub = this.audioService.requestNextParagraph$.subscribe(() => {
      this.prefetchNextParagraph();
    });
  }

  ngOnDestroy(): void {
    this.playbackEndedSub?.unsubscribe();
    this.prefetchSub?.unsubscribe();
    this.audioService.stop();
  }

  private async loadDocument(): Promise<void> {
    const doc = await this.storage.getDocument(this.id());
    if (!doc) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Document not found',
      });
      this.router.navigate(['/library']);
      return;
    }

    this.document.set(doc);

    // Restore progress
    if (doc.progress) {
      this.currentChapterIndex.set(doc.progress.chapterIndex);
      this.currentParagraphIndex.set(doc.progress.paragraphIndex);
    }
  }

  private async loadVoices(): Promise<void> {
    try {
      const voices = await this.api.getVoices().toPromise();
      this.voices.set(voices || []);
    } catch {
      // Use default voices if API fails
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
  }

  goBack(): void {
    this.router.navigate(['/library']);
  }

  /**
   * Get the next N paragraphs starting from current position
   */
  private getNextParagraphs(count: number): Array<{
    text: string;
    documentId: string;
    chapterIndex: number;
    paragraphIndex: number;
  }> {
    const doc = this.document();
    if (!doc) return [];

    const result: Array<{
      text: string;
      documentId: string;
      chapterIndex: number;
      paragraphIndex: number;
    }> = [];

    let chapterIdx = this.currentChapterIndex();
    let paraIdx = this.currentParagraphIndex();

    while (result.length < count && chapterIdx < doc.chapters.length) {
      const chapter = doc.chapters[chapterIdx];
      if (paraIdx < chapter.paragraphs.length) {
        result.push({
          text: chapter.paragraphs[paraIdx].text,
          documentId: doc.id,
          chapterIndex: chapterIdx,
          paragraphIndex: paraIdx,
        });
        paraIdx++;
      } else {
        chapterIdx++;
        paraIdx = 0;
      }
    }

    return result;
  }

  async playCurrentParagraph(): Promise<void> {
    const paragraph = this.currentParagraph();
    const doc = this.document();
    if (!paragraph || !doc) return;

    const chapterIdx = this.currentChapterIndex();
    const paraIdx = this.currentParagraphIndex();

    // If we're beyond the first paragraph and already have it cached, play immediately
    // without waiting for prefetch to complete
    if (paraIdx > 0 && this.audioService.hasPrefetchedSegment(chapterIdx, paraIdx)) {
      // Play immediately
      await this.audioService.loadAndPlay(
        paragraph.text,
        doc.id,
        chapterIdx,
        paraIdx
      );

      // Prefetch ahead in background (don't wait)
      const paragraphsToPrefetch = this.getNextParagraphs(6);
      if (paragraphsToPrefetch.length > 0) {
        this.audioService.prefetchMultipleBackground(paragraphsToPrefetch);
      }
      return;
    }

    // First play or cache miss: Prefetch current + next 5 before starting
    const paragraphsToPreload = this.getNextParagraphs(6);
    if (paragraphsToPreload.length > 0) {
      await this.audioService.prefetchMultiple(paragraphsToPreload);
    }

    // Now play (should be instant since we prefetched)
    await this.audioService.loadAndPlay(
      paragraph.text,
      doc.id,
      chapterIdx,
      paraIdx
    );
  }

  togglePlayback(): void {
    if (this.isPlaying()) {
      this.audioService.pause();
    } else if (this.duration() > 0) {
      this.audioService.play();
    } else {
      this.playCurrentParagraph();
    }
  }

  skipBack(): void {
    this.audioService.skip(-10);
  }

  skipForward(): void {
    this.audioService.skip(10);
  }

  previousParagraph(): void {
    const current = this.currentParagraphIndex();
    const chapter = this.currentChapter();

    if (current > 0) {
      this.currentParagraphIndex.set(current - 1);
    } else if (this.currentChapterIndex() > 0) {
      const newChapterIndex = this.currentChapterIndex() - 1;
      this.currentChapterIndex.set(newChapterIndex);
      const doc = this.document();
      if (doc) {
        const newChapter = doc.chapters[newChapterIndex];
        this.currentParagraphIndex.set(newChapter.paragraphs.length - 1);
      }
    }

    this.audioService.stop();
  }

  nextParagraph(): void {
    const chapter = this.currentChapter();
    const doc = this.document();
    if (!chapter || !doc) return;

    const current = this.currentParagraphIndex();

    if (current < chapter.paragraphs.length - 1) {
      this.currentParagraphIndex.set(current + 1);
    } else if (this.currentChapterIndex() < doc.chapters.length - 1) {
      this.currentChapterIndex.set(this.currentChapterIndex() + 1);
      this.currentParagraphIndex.set(0);
    }

    this.audioService.stop();
  }

  private playNextParagraphAuto(): void {
    const chapter = this.currentChapter();
    const doc = this.document();
    if (!chapter || !doc) return;

    const current = this.currentParagraphIndex();

    // Move to next paragraph
    if (current < chapter.paragraphs.length - 1) {
      this.currentParagraphIndex.set(current + 1);
      this.playCurrentParagraph();
    } else if (this.currentChapterIndex() < doc.chapters.length - 1) {
      // Move to next chapter
      this.currentChapterIndex.set(this.currentChapterIndex() + 1);
      this.currentParagraphIndex.set(0);
      this.playCurrentParagraph();
    } else {
      // End of document
      this.messageService.add({
        severity: 'info',
        summary: 'Complete',
        detail: 'You have reached the end of the document',
      });
    }
  }

  toggleContinuousMode(): void {
    this.continuousMode.set(!this.continuousMode());
    this.audioService.setContinuousPlayback(this.continuousMode());
  }

  /**
   * Prefetch the next 6 paragraphs in the background for seamless playback
   * This maintains a sliding window of 6 paragraphs ahead
   */
  private prefetchNextParagraph(): void {
    const doc = this.document();
    if (!doc || !this.continuousMode()) return;

    // Always prefetch the next 6 paragraphs from current position
    // The service is smart enough to skip already cached paragraphs
    const paragraphsToPrefetch = this.getNextParagraphs(6);
    if (paragraphsToPrefetch.length > 0) {
      // Use background prefetch - no loading state, smart caching
      this.audioService.prefetchMultipleBackground(paragraphsToPrefetch);
    }
  }

  selectChapter(index: number): void {
    this.currentChapterIndex.set(index);
    this.currentParagraphIndex.set(0);
    this.audioService.stop();
  }

  selectParagraph(chapterIndex: number, paragraphIndex: number): void {
    this.currentChapterIndex.set(chapterIndex);
    this.currentParagraphIndex.set(paragraphIndex);
    this.audioService.stop();
  }

  onSentenceClick(sentenceId: string): void {
    this.audioService.seekToSentence(sentenceId);
  }

  async onVoiceChange(voice: Voice): Promise<void> {
    this.selectedVoice.set(voice);
    await this.audioService.setVoice(voice);
  }

  async onSpeedChange(speed: number): Promise<void> {
    this.playbackSpeed.set(speed);
    await this.audioService.setSpeed(speed);
  }

  isSentenceActive(sentenceId: string): boolean {
    return this.currentSentenceId() === sentenceId;
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
