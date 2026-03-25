from pydantic import BaseModel
from enum import Enum
from typing import Optional
from datetime import datetime


class DocumentType(str, Enum):
    PDF = "pdf"
    EPUB = "epub"


class Voice(str, Enum):
    # OpenAI voices
    ALLOY = "alloy"
    ECHO = "echo"
    FABLE = "fable"
    ONYX = "onyx"
    NOVA = "nova"
    SHIMMER = "shimmer"
    # Groq voices
    AUTUMN = "autumn"
    DIANA = "diana"
    HANNAH = "hannah"
    AUSTIN = "austin"
    DANIEL = "daniel"
    TROY = "troy"


class Sentence(BaseModel):
    id: str
    text: str
    start_char: int
    end_char: int


class Paragraph(BaseModel):
    id: str
    text: str
    sentences: list[Sentence]
    page: Optional[int] = None
    is_heading: bool = False
    heading_level: Optional[int] = None


class Chapter(BaseModel):
    id: str
    title: str
    paragraphs: list[Paragraph]


class ParsedDocument(BaseModel):
    id: str
    title: str
    author: Optional[str] = None
    type: DocumentType
    chapters: list[Chapter]
    total_characters: int
    total_sentences: int
    created_at: datetime
    cover_image: Optional[str] = None  # Base64 encoded PNG


class TTSRequest(BaseModel):
    text: str
    voice: Voice = Voice.ALLOY
    speed: float = 1.0


class WordTiming(BaseModel):
    word: str
    start: float  # seconds
    end: float  # seconds


class SentenceTiming(BaseModel):
    sentence_id: str
    text: str
    start: float
    end: float
    words: list[WordTiming]


class TTSResponse(BaseModel):
    audio_base64: str
    duration: float
    timings: list[SentenceTiming]
    content_type: str = "audio/mp3"


class TTSTimingRequest(BaseModel):
    audio_base64: str
    original_text: str
    sentences: list[Sentence]
