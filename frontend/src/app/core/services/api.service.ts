import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ParsedDocument, Voice, VoiceOption, SentenceTiming, TOCEntry } from '../models/document.model';

export interface TTSResponse {
  audio_base64: string;
  duration: number;
  content_type: string;
  cached?: boolean;
}

export interface TTSWithTimingResponse {
  audio_base64: string;
  duration: number;
  timings: SentenceTiming[];
}

export interface BatchTTSRequest {
  text: string;
  voice: Voice;
  speed: number;
}

export interface BatchTTSSegment {
  index: number;
  audio_base64?: string;
  duration?: number;
  content_type?: string;
  cached?: boolean;
  error?: string;
}

export interface BatchTTSResponse {
  segments: BatchTTSSegment[];
}

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://localhost:8000/api';

  parseDocument(file: File): Observable<ParsedDocument> {
    const formData = new FormData();
    formData.append('file', file);

    return this.http
      .post<any>(`${this.baseUrl}/documents/parse`, formData)
      .pipe(
        map((response) => {
          console.log('API Response:', response);
          console.log('Cover image present:', !!response.cover_image);
          console.log('Classification:', response.classification);

          return {
            id: response.id,
            title: response.title,
            author: response.author,
            type: response.type,
            classification: response.classification,
            chapters: response.chapters,
            toc: response.toc?.map((entry: any) => ({
              title: entry.title,
              href: entry.href || '',
              level: entry.level || 1,
            })) as TOCEntry[],
            totalCharacters: response.total_characters,
            totalSentences: response.total_sentences,
            createdAt: new Date(response.created_at),
            coverImage: response.cover_image,
          };
        })
      );
  }

  generateSpeech(text: string, voice: Voice, speed: number): Observable<TTSResponse> {
    return this.http.post<TTSResponse>(`${this.baseUrl}/tts/generate`, {
      text,
      voice,
      speed,
    });
  }

  generateSpeechWithTiming(
    text: string,
    voice: Voice,
    speed: number
  ): Observable<TTSWithTimingResponse> {
    return this.http.post<TTSWithTimingResponse>(`${this.baseUrl}/tts/generate-with-timing`, {
      text,
      voice,
      speed,
    });
  }

  getVoices(): Observable<VoiceOption[]> {
    return this.http
      .get<{ voices: VoiceOption[] }>(`${this.baseUrl}/tts/voices`)
      .pipe(map((response) => response.voices));
  }

  /**
   * Generate multiple audio segments in parallel for reduced latency.
   * Useful for prefetching multiple paragraphs at once.
   */
  batchGenerateSpeech(requests: BatchTTSRequest[]): Observable<BatchTTSResponse> {
    return this.http.post<BatchTTSResponse>(`${this.baseUrl}/tts/batch-generate`, requests);
  }

  healthCheck(): Observable<{ status: string; app: string }> {
    return this.http.get<{ status: string; app: string }>(`${this.baseUrl}/health`);
  }
}
