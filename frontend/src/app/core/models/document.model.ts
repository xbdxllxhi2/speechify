export type DocumentType = 'pdf' | 'epub';

export type Voice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export interface Sentence {
  id: string;
  text: string;
  startChar: number;
  endChar: number;
}

export interface Paragraph {
  id: string;
  text: string;
  sentences: Sentence[];
  page?: number;
  isHeading: boolean;
  headingLevel?: number;
}

export interface Chapter {
  id: string;
  title: string;
  paragraphs: Paragraph[];
}

export interface ParsedDocument {
  id: string;
  title: string;
  author?: string;
  type: DocumentType;
  chapters: Chapter[];
  totalCharacters: number;
  totalSentences: number;
  createdAt: Date;
  coverImage?: string;  // Base64 encoded PNG
}

export interface StoredDocument extends ParsedDocument {
  progress: PlaybackProgress;
  coverImage?: string;
}

export interface PlaybackProgress {
  chapterIndex: number;
  paragraphIndex: number;
  sentenceIndex: number;
  audioTime: number;
  lastPlayedAt: Date;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface SentenceTiming {
  sentenceId: string;
  text: string;
  start: number;
  end: number;
  words: WordTiming[];
}

export interface TTSOptions {
  voice: Voice;
  speed: number;
}

export interface AudioSegment {
  id: string;
  documentId: string;
  chapterIndex: number;
  paragraphIndex: number;
  audioBlob: Blob;
  duration: number;
  timings: SentenceTiming[];
  createdAt: Date;
}

export interface VoiceOption {
  id: Voice;
  name: string;
  description: string;
}

export interface AppSettings {
  voice: Voice;
  speed: number;
  theme: 'light' | 'dark';
  autoPlay: boolean;
  highlightMode: 'sentence' | 'word';
}

export const DEFAULT_SETTINGS: AppSettings = {
  voice: 'nova',
  speed: 1.0,
  theme: 'light',
  autoPlay: true,
  highlightMode: 'sentence',
};
