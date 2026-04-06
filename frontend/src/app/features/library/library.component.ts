import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { FileUploadModule, FileUploadHandlerEvent } from 'primeng/fileupload';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';

import { ApiService } from '../../core/services/api.service';
import { StorageService } from '../../core/services/storage.service';
import { AudioService } from '../../core/services/audio.service';
import { StoredDocument, PlaybackProgress } from '../../core/models/document.model';

@Component({
  selector: 'app-library',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    FileUploadModule,
    ProgressBarModule,
    ToastModule,
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './library.component.html',
})
export class LibraryComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly storage = inject(StorageService);
  private readonly audioService = inject(AudioService);
  private readonly router = inject(Router);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);

  // Expose for template
  hasActivePlayback = this.audioService.hasActivePlayback;

  documents = signal<StoredDocument[]>([]);
  isLoading = signal(false);
  uploadProgress = signal(0);
  isUploading = signal(false);
  selectedDocuments = signal<Set<string>>(new Set());
  isSelectionMode = signal(false);

  // Search and sort
  searchQuery = signal('');
  sortField = signal<'title' | 'createdAt' | 'type'>('createdAt');
  sortOrder = signal<1 | -1>(-1); // 1 = asc, -1 = desc

  // Computed: Filtered and sorted documents
  filteredDocuments = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const field = this.sortField();
    const order = this.sortOrder();

    let docs = this.documents();

    // Filter by search query
    if (query) {
      docs = docs.filter(doc =>
        doc.title.toLowerCase().includes(query) ||
        (doc.author?.toLowerCase().includes(query)) ||
        doc.type.toLowerCase().includes(query)
      );
    }

    // Sort
    return [...docs].sort((a, b) => {
      let comparison = 0;
      if (field === 'title') {
        comparison = a.title.localeCompare(b.title);
      } else if (field === 'type') {
        comparison = a.type.localeCompare(b.type);
      } else if (field === 'createdAt') {
        comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return comparison * order;
    });
  });

  // Computed: Recent documents (last 5 by play time, with progress > 0)
  recentDocuments = computed(() => {
    return this.documents()
      .filter(doc => this.getReadingProgress(doc) > 0)
      .sort((a, b) => {
        const aTime = new Date(a.progress.lastPlayedAt).getTime();
        const bTime = new Date(b.progress.lastPlayedAt).getTime();
        return bTime - aTime; // Most recent first
      })
      .slice(0, 5);
  });

  ngOnInit(): void {
    this.loadDocuments();
  }

  async loadDocuments(): Promise<void> {
    this.isLoading.set(true);
    try {
      const docs = await this.storage.getAllDocuments();
      this.documents.set(docs);
    } finally {
      this.isLoading.set(false);
    }
  }

  async onFileUpload(event: FileUploadHandlerEvent): Promise<void> {
    const file = event.files[0];
    if (!file) return;

    this.isUploading.set(true);
    this.uploadProgress.set(10);

    try {
      this.uploadProgress.set(30);

      const parsed = await this.api.parseDocument(file).toPromise();
      if (!parsed) {
        throw new Error('Failed to parse document');
      }

      console.log('Parsed document:', parsed);
      console.log('Cover image present:', !!parsed.coverImage);
      console.log('Cover image length:', parsed.coverImage?.length);

      this.uploadProgress.set(70);

      const defaultProgress: PlaybackProgress = {
        chapterIndex: 0,
        paragraphIndex: 0,
        sentenceIndex: 0,
        audioTime: 0,
        lastPlayedAt: new Date(),
      };

      const storedDoc: StoredDocument = {
        ...parsed,
        progress: defaultProgress,
      };

      console.log('Storing document with cover image:', !!storedDoc.coverImage);

      await this.storage.saveDocument(storedDoc);
      this.uploadProgress.set(100);

      this.messageService.add({
        severity: 'success',
        summary: 'Success',
        detail: `"${parsed.title}" uploaded successfully`,
      });

      await this.loadDocuments();
    } catch (error) {
      console.error('Upload error:', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: error instanceof Error ? error.message : 'Failed to upload document',
      });
    } finally {
      this.isUploading.set(false);
      this.uploadProgress.set(0);
    }
  }

  openDocument(doc: StoredDocument): void {
    this.router.navigate(['/reader', doc.id]);
  }

  confirmDelete(doc: StoredDocument, event: Event): void {
    event.stopPropagation();
    this.confirmationService.confirm({
      target: event.target as EventTarget,
      message: `Delete "${doc.title}"? This will also remove cached audio.`,
      icon: 'pi pi-exclamation-triangle',
      accept: () => this.deleteDocument(doc),
    });
  }

  async deleteDocument(doc: StoredDocument): Promise<void> {
    try {
      await this.storage.deleteDocument(doc.id);
      this.messageService.add({
        severity: 'success',
        summary: 'Deleted',
        detail: `"${doc.title}" has been removed`,
      });
      await this.loadDocuments();
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to delete document',
      });
    }
  }

  formatDate(date: Date): string {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  getReadingProgress(doc: StoredDocument): number {
    const totalParagraphs = doc.chapters.reduce((acc, ch) => acc + ch.paragraphs.length, 0);
    if (totalParagraphs === 0) return 0;

    let completedParagraphs = 0;
    for (let i = 0; i < doc.progress.chapterIndex; i++) {
      completedParagraphs += doc.chapters[i]?.paragraphs.length || 0;
    }
    completedParagraphs += doc.progress.paragraphIndex;

    return Math.round((completedParagraphs / totalParagraphs) * 100);
  }

  // Multi-select functionality
  toggleSelectionMode(): void {
    this.isSelectionMode.update(mode => !mode);
    if (!this.isSelectionMode()) {
      this.selectedDocuments.set(new Set());
    }
  }

  toggleDocumentSelection(docId: string): void {
    this.selectedDocuments.update(selected => {
      const newSelected = new Set(selected);
      if (newSelected.has(docId)) {
        newSelected.delete(docId);
      } else {
        newSelected.add(docId);
      }
      return newSelected;
    });
  }

  isDocumentSelected(docId: string): boolean {
    return this.selectedDocuments().has(docId);
  }

  selectAll(): void {
    this.selectedDocuments.set(new Set(this.filteredDocuments().map(d => d.id)));
  }

  deselectAll(): void {
    this.selectedDocuments.set(new Set());
  }

  toggleSort(field: 'title' | 'createdAt' | 'type'): void {
    if (this.sortField() === field) {
      // Toggle order if same field
      this.sortOrder.update(o => o === 1 ? -1 : 1);
    } else {
      // Set new field with default order
      this.sortField.set(field);
      this.sortOrder.set(field === 'createdAt' ? -1 : 1);
    }
  }

  confirmBulkDelete(event: Event): void {
    const count = this.selectedDocuments().size;
    if (count === 0) return;

    this.confirmationService.confirm({
      target: event.target as EventTarget,
      message: `Delete ${count} document${count > 1 ? 's' : ''}? This will also remove cached audio.`,
      icon: 'pi pi-exclamation-triangle',
      accept: () => this.deleteBulkDocuments(),
    });
  }

  async deleteBulkDocuments(): Promise<void> {
    const idsToDelete = Array.from(this.selectedDocuments());
    const count = idsToDelete.length;

    try {
      await Promise.all(idsToDelete.map(id => this.storage.deleteDocument(id)));

      this.messageService.add({
        severity: 'success',
        summary: 'Deleted',
        detail: `${count} document${count > 1 ? 's' : ''} removed`,
      });

      this.selectedDocuments.set(new Set());
      this.isSelectionMode.set(false);
      await this.loadDocuments();
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to delete documents',
      });
    }
  }
}
