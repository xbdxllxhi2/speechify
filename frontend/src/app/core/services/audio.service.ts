import { Injectable, signal, computed, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { SentenceTiming, Voice, PlaybackProgress, Chapter } from '../models/document.model';
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

export interface CurrentDocument {
  id: string;
  title: string;
  author?: string;
  coverImage?: string;
  chapterTitle?: string;
}

export interface PlaybackEndedEvent {
  documentId: string;
  chapterIndex: number;
  paragraphIndex: number;
}

export interface PlaylistEntry {
  text: string;
  chapterIndex: number;
  paragraphIndex: number;
  chapterTitle: string;
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

  // Playlist: flat list of all paragraphs for auto-advance
  private playlist: PlaylistEntry[] = [];
  private playlistIndex = -1;

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

  // Emitted when auto-advance changes the playback position
  private readonly _positionChanged = new Subject<{ chapterIndex: number; paragraphIndex: number }>();
  readonly positionChanged$ = this._positionChanged.asObservable();

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

  // Current document info for mini player
  private readonly _currentDocument = signal<CurrentDocument | null>(null);
  readonly currentDocument = this._currentDocument.asReadonly();
  readonly hasActivePlayback = computed(() => this._currentDocument() !== null);

  // Settings
  private _voice = signal<Voice>('nova');
  private _speed = signal<number>(1.0);
  readonly voice = this._voice.asReadonly();
  readonly speed = this._speed.asReadonly();

  constructor() {
    this.loadSettings();
    this.setupMediaSession();
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.storage.getSettings();
    this._voice.set(settings.voice);
    this._speed.set(settings.speed);
  }

  private setupMediaSession(): void {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => this.skip(10));
      navigator.mediaSession.setActionHandler('previoustrack', () => this.requestPreviousParagraph());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.requestNextParagraphAction());
    }
  }

  private updateMediaSession(): void {
    if ('mediaSession' in navigator && this._currentDocument()) {
      const doc = this._currentDocument()!;
      const artwork: MediaImage[] = [];

      if (doc.coverImage) {
        artwork.push({
          src: `data:image/png;base64,${doc.coverImage}`,
          sizes: '512x512',
          type: 'image/png',
        });
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: doc.chapterTitle || doc.title,
        artist: doc.author || 'Listenify',
        album: doc.title,
        artwork,
      });
    }
  }

  private updateMediaSessionState(): void {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this._state().isPlaying ? 'playing' : 'paused';
    }
  }

  // Event for requesting previous paragraph from reader
  private readonly _requestPreviousParagraph = new Subject<void>();
  readonly requestPreviousParagraph$ = this._requestPreviousParagraph.asObservable();

  private requestPreviousParagraph(): void {
    this._requestPreviousParagraph.next();
  }

  private requestNextParagraphAction(): void {
    this._requestNextParagraph.next();
  }

  /**
   * Set the current document for mini player display
   */
  setCurrentDocument(doc: CurrentDocument | null): void {
    this._currentDocument.set(doc);
    if (doc) {
      this.updateMediaSession();
    }
  }

  /**
   * Update chapter title for the current document
   */
  updateChapterTitle(title: string): void {
    const current = this._currentDocument();
    if (current) {
      this._currentDocument.set({ ...current, chapterTitle: title });
      this.updateMediaSession();
    }
  }

  /**
   * Get current playback position info for mini player
   */
  getCurrentPosition(): { chapterIndex: number; paragraphIndex: number } {
    return {
      chapterIndex: this.chapterIndex,
      paragraphIndex: this.paragraphIndex,
    };
  }

  async setVoice(voice: Voice): Promise<void> {
    if (this._voice() === voice) return;

    this._voice.set(voice);
    await this.storage.setSetting('voice', voice);

    // Clear prefetched segments since they used the old voice
    this.prefetchedSegments.clear();
    this.prefetchInProgress.clear();

    // If we have a current document, clear its audio cache too
    if (this.documentId) {
      await this.storage.clearAudioCache(this.documentId);
    }
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
   * Set the full document playlist so the service can auto-advance through all paragraphs.
   */
  setPlaylist(chapters: Chapter[], documentId: string): void {
    this.playlist = [];
    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      for (let pi = 0; pi < chapter.paragraphs.length; pi++) {
        this.playlist.push({
          text: chapter.paragraphs[pi].text,
          chapterIndex: ci,
          paragraphIndex: pi,
          chapterTitle: chapter.title,
        });
      }
    }
    this.documentId = documentId;
    this.syncPlaylistIndex();
  }

  /**
   * Sync playlist index to current chapter/paragraph position
   */
  private syncPlaylistIndex(): void {
    this.playlistIndex = this.playlist.findIndex(
      (e) => e.chapterIndex === this.chapterIndex && e.paragraphIndex === this.paragraphIndex
    );
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

      // Emit event for readers that are listening
      if (this.documentId) {
        this._playbackEnded.next({
          documentId: this.documentId,
          chapterIndex: this.chapterIndex,
          paragraphIndex: this.paragraphIndex,
        });
      }

      // Auto-advance to next paragraph using playlist
      if (this.continuousPlayback && this.playlist.length > 0) {
        this.autoAdvance();
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
    this.updateMediaSessionState();
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
      this.updateMediaSessionState();
    }
  }

  pause(): void {
    if (this.audio && this._state().isPlaying) {
      this.audio.pause();
      this._state.update((s) => ({ ...s, isPlaying: false }));
      this.updateMediaSessionState();
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

  /**
   * Auto-advance to the next paragraph in the playlist.
   * Works even when the reader component is not active (e.g. from mini player).
   */
  private async autoAdvance(): Promise<void> {
    this.syncPlaylistIndex();
    const nextIndex = this.playlistIndex + 1;

    if (nextIndex >= this.playlist.length) {
      // End of book
      return;
    }

    const next = this.playlist[nextIndex];
    this.playlistIndex = nextIndex;
    this.chapterIndex = next.chapterIndex;
    this.paragraphIndex = next.paragraphIndex;

    // Update chapter title in mini player
    this.updateChapterTitle(next.chapterTitle);

    // Notify reader component to sync its UI if it's active
    this._positionChanged.next({
      chapterIndex: next.chapterIndex,
      paragraphIndex: next.paragraphIndex,
    });

    // Prefetch next few paragraphs in background
    this.prefetchAhead(nextIndex);

    // Play the next paragraph
    await this.loadAndPlay(
      next.text,
      this.documentId!,
      next.chapterIndex,
      next.paragraphIndex
    );
  }

  /**
   * Prefetch paragraphs ahead of the given playlist index
   */
  private prefetchAhead(fromIndex: number): void {
    const upcoming: Array<{
      text: string;
      documentId: string;
      chapterIndex: number;
      paragraphIndex: number;
    }> = [];

    for (let i = fromIndex + 1; i < Math.min(fromIndex + 6, this.playlist.length); i++) {
      const entry = this.playlist[i];
      upcoming.push({
        text: entry.text,
        documentId: this.documentId!,
        chapterIndex: entry.chapterIndex,
        paragraphIndex: entry.paragraphIndex,
      });
    }

    if (upcoming.length > 0) {
      this.prefetchMultipleBackground(upcoming);
    }
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
      this._currentDocument.set(null);
      this.updateMediaSessionState();
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
    this.playlist = [];
    this.playlistIndex = -1;

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

    // Clear current document
    this._currentDocument.set(null);
    this.updateMediaSessionState();
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
