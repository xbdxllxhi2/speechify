import { Component, inject, computed, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AudioService } from '../../../core/services/audio.service';

@Component({
  selector: 'app-mini-player',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div
        class="fixed bottom-[60px] md:bottom-0 left-0 right-0 z-50 bg-white border-t border-slate-200 shadow-lg md:safe-area-bottom"
      >
        <!-- Progress bar -->
        <div class="h-1 bg-slate-200">
          <div
            class="h-full bg-emerald-500 transition-all duration-200"
            [style.width.%]="progressPercent()"
          ></div>
        </div>

        <div class="max-w-5xl mx-auto flex items-center gap-3 px-4 py-3">
          <!-- Cover Image -->
          <div
            class="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-slate-100 cursor-pointer"
            (click)="navigateToReader()"
          >
            @if (currentDocument()?.coverImage) {
              <img
                [src]="'data:image/png;base64,' + currentDocument()!.coverImage"
                alt="Cover"
                class="w-full h-full object-cover"
              />
            } @else {
              <div class="w-full h-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center">
                <i class="pi pi-book text-white text-lg"></i>
              </div>
            }
          </div>

          <!-- Track Info -->
          <div class="flex-1 min-w-0 cursor-pointer" (click)="navigateToReader()">
            <p class="text-sm font-medium truncate">
              {{ currentDocument()?.title || 'Unknown' }}
            </p>
            <p class="text-xs text-slate-500 truncate">
              {{ currentDocument()?.chapterTitle || currentDocument()?.author || 'Listenify' }}
            </p>
          </div>

          <!-- Controls -->
          <div class="flex items-center gap-1">
            <!-- Skip Back -->
            <button
              type="button"
              class="w-10 h-10 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 transition-colors"
              (click)="onSkipBack($event)"
            >
              <i class="pi pi-replay text-sm"></i>
            </button>

            <!-- Play/Pause -->
            <button
              type="button"
              class="w-12 h-12 rounded-full flex items-center justify-center bg-emerald-500 text-white hover:bg-emerald-600 transition-colors shadow-md"
              (click)="onToggle($event)"
            >
              @if (isLoading()) {
                <i class="pi pi-spin pi-spinner text-lg"></i>
              } @else if (isPlaying()) {
                <i class="pi pi-pause text-lg"></i>
              } @else {
                <i class="pi pi-play text-lg ml-0.5"></i>
              }
            </button>

            <!-- Skip Forward -->
            <button
              type="button"
              class="w-10 h-10 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 transition-colors"
              (click)="onSkipForward($event)"
            >
              <i class="pi pi-forward text-sm"></i>
            </button>

            <!-- Close -->
            <button
              type="button"
              class="w-10 h-10 rounded-full flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              (click)="onStop($event)"
            >
              <i class="pi pi-times text-sm"></i>
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class MiniPlayerComponent {
  readonly audioService = inject(AudioService);
  private readonly router = inject(Router);

  readonly currentDocument = this.audioService.currentDocument;
  readonly isPlaying = this.audioService.isPlaying;
  readonly isLoading = this.audioService.isLoading;
  readonly currentTime = this.audioService.currentTime;
  readonly duration = this.audioService.duration;

  private readonly onReaderPage = signal(false);

  readonly visible = computed(() => this.audioService.hasActivePlayback() && !this.onReaderPage());

  readonly progressPercent = computed(() => {
    const d = this.duration();
    if (d === 0) return 0;
    return (this.currentTime() / d) * 100;
  });

  constructor() {
    this.onReaderPage.set(this.router.url.startsWith('/reader'));
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.onReaderPage.set(e.urlAfterRedirects.startsWith('/reader')));
  }

  navigateToReader(): void {
    const doc = this.currentDocument();
    if (doc) {
      this.router.navigate(['/reader', doc.id]);
    }
  }

  onToggle(event: Event): void {
    event.stopPropagation();
    this.audioService.toggle();
  }

  onSkipBack(event: Event): void {
    event.stopPropagation();
    this.audioService.skip(-10);
  }

  onSkipForward(event: Event): void {
    event.stopPropagation();
    this.audioService.skip(10);
  }

  onStop(event: Event): void {
    event.stopPropagation();
    this.audioService.stop();
  }
}
