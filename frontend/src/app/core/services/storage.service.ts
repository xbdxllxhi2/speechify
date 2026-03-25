import { Injectable } from '@angular/core';
import Dexie, { Table } from 'dexie';
import {
  StoredDocument,
  AudioSegment,
  AppSettings,
  DEFAULT_SETTINGS,
  PlaybackProgress,
} from '../models/document.model';

class ListenifyDatabase extends Dexie {
  documents!: Table<StoredDocument, string>;
  audioCache!: Table<AudioSegment, string>;
  settings!: Table<{ key: string; value: any }, string>;

  constructor() {
    super('ListenifyDB');

    this.version(1).stores({
      documents: 'id, title, type, createdAt',
      audioCache: 'id, documentId, chapterIndex, paragraphIndex',
      settings: 'key',
    });
  }
}

@Injectable({
  providedIn: 'root',
})
export class StorageService {
  private db = new ListenifyDatabase();

  // Documents
  async saveDocument(document: StoredDocument): Promise<void> {
    await this.db.documents.put(document);
  }

  async getDocument(id: string): Promise<StoredDocument | undefined> {
    return this.db.documents.get(id);
  }

  async getAllDocuments(): Promise<StoredDocument[]> {
    return this.db.documents.orderBy('createdAt').reverse().toArray();
  }

  async deleteDocument(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.documents, this.db.audioCache], async () => {
      await this.db.documents.delete(id);
      await this.db.audioCache.where('documentId').equals(id).delete();
    });
  }

  async updateProgress(documentId: string, progress: PlaybackProgress): Promise<void> {
    await this.db.documents.update(documentId, { progress });
  }

  // Audio Cache
  async saveAudioSegment(segment: AudioSegment): Promise<void> {
    await this.db.audioCache.put(segment);
  }

  async getAudioSegment(
    documentId: string,
    chapterIndex: number,
    paragraphIndex: number
  ): Promise<AudioSegment | undefined> {
    return this.db.audioCache
      .where({ documentId, chapterIndex, paragraphIndex })
      .first();
  }

  async getDocumentAudioSegments(documentId: string): Promise<AudioSegment[]> {
    return this.db.audioCache.where('documentId').equals(documentId).toArray();
  }

  async clearAudioCache(documentId?: string): Promise<void> {
    if (documentId) {
      await this.db.audioCache.where('documentId').equals(documentId).delete();
    } else {
      await this.db.audioCache.clear();
    }
  }

  // Settings
  async getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
    const setting = await this.db.settings.get(key);
    return setting?.value ?? DEFAULT_SETTINGS[key];
  }

  async setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  async getSettings(): Promise<AppSettings> {
    const settings = await this.db.settings.toArray();
    const result = { ...DEFAULT_SETTINGS };
    for (const { key, value } of settings) {
      (result as any)[key] = value;
    }
    return result;
  }

  async saveSettings(settings: Partial<AppSettings>): Promise<void> {
    const entries = Object.entries(settings) as [keyof AppSettings, any][];
    await this.db.settings.bulkPut(entries.map(([key, value]) => ({ key, value })));
  }

  // Storage stats
  async getStorageStats(): Promise<{
    documentsCount: number;
    audioCacheSize: number;
  }> {
    const documentsCount = await this.db.documents.count();
    const audioSegments = await this.db.audioCache.toArray();
    const audioCacheSize = audioSegments.reduce(
      (acc, segment) => acc + segment.audioBlob.size,
      0
    );
    return { documentsCount, audioCacheSize };
  }
}
