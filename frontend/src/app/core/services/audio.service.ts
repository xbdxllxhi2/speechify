import { Injectable, signal, computed, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { SentenceTiming, Voice, PlaybackProgress } from '../models/document.model';
import { ApiService } from './api.service';
import { StorageService } from './storage.service';

export interface PlaybackState {
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  currentSentenceId: string | null;
  error: string | null;
}

export interface PlaybackEndedEvent {
  documentId: string;
  chapterIndex: number;
  paragraphIndex: number;
}

@Injectable({
  providedIn: 'root',
})
export class AudioService {
  private readonly api = inject(ApiService);
  private readonly storage = inject(StorageService);

  private audio: HTMLAudioElement | null = null;
  private timings: SentenceTiming[] = [];
  private documentId: string | null = null;
  private chapterIndex = 0;
  private paragraphIndex = 0;
  private continuousPlayback = true;

  // Prefetch state
  private prefetchInProgress = new Set<string>(); // Track multiple prefetches by key
  private prefetchedSegments = new Map<string, {
    chapterIndex: number;
    paragraphIndex: number;
    blob: Blob;
    timings: SentenceTiming[];
  }>();

  private getSegmentKey(chapterIndex: number, paragraphIndex: number): string {
    return `${chapterIndex}-${paragraphIndex}`;
  }

  // Event emitter for when playback ends
  private readonly _playbackEnded = new Subject<PlaybackEndedEvent>();
  readonly playbackEnded$ = this._playbackEnded.asObservable();

  // Request next paragraph info from reader
  private readonly _requestNextParagraph = new Subject<void>();
  readonly requestNextParagraph$ = this._requestNextParagraph.asObservable();

  // Signals for reactive state
  private readonly _state = signal<PlaybackState>({
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    currentSentenceId: null,
    error: null,
  });

  readonly state = this._state.asReadonly();
  readonly isPlaying = computed(() => this._state().isPlaying);
  readonly isLoading = computed(() => this._state().isLoading);
  readonly currentTime = computed(() => this._state().currentTime);
  readonly duration = computed(() => this._state().duration);
  readonly currentSentenceId = computed(() => this._state().currentSentenceId);

  // Settings
  private _voice = signal<Voice>('nova');
  private _speed = signal<number>(1.0);
  readonly voice = this._voice.asReadonly();
  readonly speed = this._speed.asReadonly();

  constructor() {
    this.loadSettings();
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.storage.getSettings();
    this._voice.set(settings.voice);
    this._speed.set(settings.speed);
  }

  async setVoice(voice: Voice): Promise<void> {
    this._voice.set(voice);
    await this.storage.setSetting('voice', voice);
  }

  async setSpeed(speed: number): Promise<void> {
    this._speed.set(speed);
    await this.storage.setSetting('speed', speed);
    if (this.audio) {
      this.audio.playbackRate = speed;
    }
  }

  setContinuousPlayback(enabled: boolean): void {
    this.continuousPlayback = enabled;
  }

  /**
   * Prefetch audio for a paragraph in the background.
   * Returns a promise that resolves when prefetch is complete.
   */
  async prefetchSegment(
    text: string,
    documentId: string,
    chapterIndex: number,
    paragraphIndex: number
  ): Promise<void> {
    const key = this.getSegmentKey(chapterIndex, paragraphIndex);

    // Already prefetched in memory
    if (this.prefetchedSegments.has(key)) {
      return;
    }

    // Already prefetching this segment
    if (this.prefetchInProgress.has(key)) {
      // Wait for existing prefetch to complete
      while (this.prefetchInProgress.has(key)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    // Check if already cached in storage
    const cached = await this.storage.getAudioSegment(documentId, chapterIndex, paragraphIndex);
    if (cached) {
      this.prefetchedSegments.set(key, {
        chapterIndex,
        paragraphIndex,
        blob: cached.audioBlob,
        timings: cached.timings,
      });
      return;
    }

    this.prefetchInProgress.add(key);

    try {
      const response = await this.api
        .generateSpeechWithTiming(text, this._voice(), this._speed())
        .toPromise();

      if (!response) return;

      const audioBytes = Uint8Array.from(atob(response.audio_base64), (c) => c.charCodeAt(0));
      const blob = new Blob([audioBytes], { type: 'audio/mp3' });

      // Cache in storage
      await this.storage.saveAudioSegment({
        id: `${documentId}-${chapterIndex}-${paragraphIndex}`,
        documentId,
        chapterIndex,
        paragraphIndex,
        audioBlob: blob,
        duration: response.duration,
        timings: response.timings,
        createdAt: new Date(),
      });

      // Store in memory for immediate use
      this.prefetchedSegments.set(key, {
        chapterIndex,
        paragraphIndex,
        blob,
        timings: response.timings,
      });
    } catch (error) {
      console.warn('Prefetch failed:', error);
    } finally {
      this.prefetchInProgress.delete(key);
    }
  }

  /**
   * Prefetch multiple paragraphs in parallel without showing loading state (background)
   */
  async prefetchMultipleBackground(
    paragraphs: Array<{
      text: string;
      documentId: string;
      chapterIndex: number;
      paragraphIndex: number;
    }>
  ): Promise<void> {
    // Fire and forget - don't block or show loading state
    try {
      await Promise.all(
        paragraphs.map((p) =>
          this.prefetchSegment(p.text, p.documentId, p.chapterIndex, p.paragraphIndex)
        )
      );
    } catch (error) {
      console.warn('Background prefetch failed:', error);
    }
  }

  /**
   * Prefetch multiple paragraphs in parallel (shows loading state)
   */
  async prefetchMultiple(
    paragraphs: Array<{
      text: string;
      documentId: string;
      chapterIndex: number;
      paragraphIndex: number;
    }>
  ): Promise<void> {
    this._state.update((s) => ({ ...s, isLoading: true }));
    try {
      await Promise.all(
        paragraphs.map((p) =>
          this.prefetchSegment(p.text, p.documentId, p.chapterIndex, p.paragraphIndex)
        )
      );
    } finally {
      this._state.update((s) => ({ ...s, isLoading: false }));
    }
  }

  /**
   * Legacy method for background prefetch (doesn't block)
   */
  prefetchNext(
    text: string,
    documentId: string,
    chapterIndex: number,
    paragraphIndex: number
  ): void {
    // Fire and forget
    this.prefetchSegment(text, documentId, chapterIndex, paragraphIndex);
  }

  /**
   * Check if we have prefetched audio ready for given indices
   */
  hasPrefetchedSegment(chapterIndex: number, paragraphIndex: number): boolean {
    const key = this.getSegmentKey(chapterIndex, paragraphIndex);
    return this.prefetchedSegments.has(key);
  }

  /**
   * Get and consume a prefetched segment
   */
  private consumePrefetchedSegment(chapterIndex: number, paragraphIndex: number) {
    const key = this.getSegmentKey(chapterIndex, paragraphIndex);
    const segment = this.prefetchedSegments.get(key);
    if (segment) {
      this.prefetchedSegments.delete(key);
    }
    return segment;
  }

  async loadAndPlay(
    text: string,
    documentId: string,
    chapterIndex: number,
    paragraphIndex: number,
    startSentenceId?: string
  ): Promise<void> {
    this.documentId = documentId;
    this.chapterIndex = chapterIndex;
    this.paragraphIndex = paragraphIndex;

    this._state.update((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Check if we have prefetched this segment
      const prefetched = this.consumePrefetchedSegment(chapterIndex, paragraphIndex);
      if (prefetched) {
        await this.playFromBlob(prefetched.blob, prefetched.timings, startSentenceId);
        // Request prefetch of next paragraph
        this._requestNextParagraph.next();
        return;
      }

      // Check cache
      const cached = await this.storage.getAudioSegment(documentId, chapterIndex, paragraphIndex);

      if (cached) {
        await this.playFromBlob(cached.audioBlob, cached.timings, startSentenceId);
        // Request prefetch of next paragraph
        this._requestNextParagraph.next();
        return;
      }

      // Generate new audio with timing
      const response = await this.api
        .generateSpeechWithTiming(text, this._voice(), this._speed())
        .toPromise();

      if (!response) {
        throw new Error('Failed to generate audio');
      }

      // Decode base64 audio
      const audioBytes = Uint8Array.from(atob(response.audio_base64), (c) => c.charCodeAt(0));
      const blob = new Blob([audioBytes], { type: 'audio/mp3' });

      // Cache the audio
      await this.storage.saveAudioSegment({
        id: `${documentId}-${chapterIndex}-${paragraphIndex}`,
        documentId,
        chapterIndex,
        paragraphIndex,
        audioBlob: blob,
        duration: response.duration,
        timings: response.timings,
        createdAt: new Date(),
      });

      await this.playFromBlob(blob, response.timings, startSentenceId);

      // Request prefetch of next paragraph
      this._requestNextParagraph.next();
    } catch (error) {
      this._state.update((s) => ({
        ...s,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load audio',
      }));
    }
  }

  private async playFromBlob(
    blob: Blob,
    timings: SentenceTiming[],
    startSentenceId?: string
  ): Promise<void> {
    // Cleanup previous audio
    if (this.audio) {
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
    }

    this.timings = timings;
    const url = URL.createObjectURL(blob);
    this.audio = new Audio(url);
    this.audio.playbackRate = this._speed();

    // Set up event listeners
    this.audio.onloadedmetadata = () => {
      this._state.update((s) => ({
        ...s,
        duration: this.audio?.duration || 0,
        isLoading: false,
      }));

      // Seek to start sentence if provided
      if (startSentenceId) {
        const timing = this.timings.find((t) => t.sentenceId === startSentenceId);
        if (timing && this.audio) {
          this.audio.currentTime = timing.start;
        }
      }
    };

    this.audio.ontimeupdate = () => {
      const currentTime = this.audio?.currentTime || 0;
      const currentSentence = this.findCurrentSentence(currentTime);

      this._state.update((s) => ({
        ...s,
        currentTime,
        currentSentenceId: currentSentence?.sentenceId || null,
      }));
    };

    this.audio.onended = () => {
      this._state.update((s) => ({ ...s, isPlaying: false }));
      this.saveProgress();

      // Emit event for continuous playback
      if (this.continuousPlayback && this.documentId) {
        this._playbackEnded.next({
          documentId: this.documentId,
          chapterIndex: this.chapterIndex,
          paragraphIndex: this.paragraphIndex,
        });
      }
    };

    this.audio.onerror = () => {
      this._state.update((s) => ({
        ...s,
        isLoading: false,
        isPlaying: false,
        error: 'Audio playback error',
      }));
    };

    // Start playback
    await this.audio.play();
    this._state.update((s) => ({ ...s, isPlaying: true }));
  }

  private findCurrentSentence(time: number): SentenceTiming | null {
    for (const timing of this.timings) {
      if (time >= timing.start && time <= timing.end) {
        return timing;
      }
    }
    return null;
  }

  play(): void {
    if (this.audio && !this._state().isPlaying) {
      this.audio.play();
      this._state.update((s) => ({ ...s, isPlaying: true }));
    }
  }

  pause(): void {
    if (this.audio && this._state().isPlaying) {
      this.audio.pause();
      this._state.update((s) => ({ ...s, isPlaying: false }));
      this.saveProgress();
    }
  }

  toggle(): void {
    if (this._state().isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  seekToSentence(sentenceId: string): void {
    const timing = this.timings.find((t) => t.sentenceId === sentenceId);
    if (timing && this.audio) {
      this.audio.currentTime = timing.start;
      if (!this._state().isPlaying) {
        this.play();
      }
    }
  }

  seekTo(time: number): void {
    if (this.audio) {
      this.audio.currentTime = Math.max(0, Math.min(time, this.audio.duration));
    }
  }

  skip(seconds: number): void {
    if (this.audio) {
      this.seekTo(this.audio.currentTime + seconds);
    }
  }

  private async saveProgress(): Promise<void> {
    if (!this.documentId || !this.audio) return;

    const sentenceIndex = this.timings.findIndex(
      (t) => t.sentenceId === this._state().currentSentenceId
    );

    const progress: PlaybackProgress = {
      chapterIndex: this.chapterIndex,
      paragraphIndex: this.paragraphIndex,
      sentenceIndex: Math.max(0, sentenceIndex),
      audioTime: this.audio.currentTime,
      lastPlayedAt: new Date(),
    };

    await this.storage.updateProgress(this.documentId, progress);
  }

  stop(): void {
    if (this.audio) {
      this.saveProgress();
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
      this.audio = null;
      this.timings = [];
      this._state.set({
        isPlaying: false,
        isLoading: false,
        currentTime: 0,
        duration: 0,
        currentSentenceId: null,
        error: null,
      });
    }
  }

  /**
   * Fully reset the audio service for a new document.
   * Clears all state, prefetched segments, and stops playback.
   */
  reset(): void {
    // Stop current playback and clean up audio element
    if (this.audio) {
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
      this.audio = null;
    }

    // Clear all state
    this.timings = [];
    this.documentId = null;
    this.chapterIndex = 0;
    this.paragraphIndex = 0;

    // Clear all prefetched segments
    this.prefetchedSegments.clear();
    this.prefetchInProgress.clear();

    // Reset state signal
    this._state.set({
      isPlaying: false,
      isLoading: false,
      currentTime: 0,
      duration: 0,
      currentSentenceId: null,
      error: null,
    });
  }

  /**
   * Clear prefetched segments for a specific document or all if no documentId provided
   */
  clearPrefetchedSegments(documentId?: string): void {
    if (documentId && this.documentId !== documentId) {
      // Only clear if we're switching to a different document
      this.prefetchedSegments.clear();
      this.prefetchInProgress.clear();
    } else if (!documentId) {
      this.prefetchedSegments.clear();
      this.prefetchInProgress.clear();
    }
  }
}
