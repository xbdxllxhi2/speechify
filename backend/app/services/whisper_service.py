import tempfile
import os
import re
from typing import Optional
from openai import OpenAI

from app.models.schemas import Sentence, SentenceTiming, WordTiming
from app.config import get_settings

settings = get_settings()


def align_words_to_sentences(
    words: list[dict],
    sentences: list[Sentence],
) -> list[SentenceTiming]:
    """Align Whisper word timings to original sentences."""
    timings = []
    word_idx = 0

    for sentence in sentences:
        sentence_words = []
        sentence_text_lower = sentence.text.lower()

        # Find words belonging to this sentence
        start_time = None
        end_time = None

        while word_idx < len(words):
            word = words[word_idx]
            word_text = word["word"].strip().lower()

            # Check if word appears in sentence
            if word_text in sentence_text_lower:
                if start_time is None:
                    start_time = word["start"]
                end_time = word["end"]

                sentence_words.append(
                    WordTiming(
                        word=word["word"].strip(),
                        start=word["start"],
                        end=word["end"],
                    )
                )
                word_idx += 1

                # Check if we've likely finished this sentence
                if word_text.endswith(('.', '!', '?')):
                    break
            else:
                # Word doesn't match, might be next sentence
                if sentence_words:
                    break
                word_idx += 1

        timings.append(
            SentenceTiming(
                sentence_id=sentence.id,
                text=sentence.text,
                start=start_time or 0.0,
                end=end_time or 0.0,
                words=sentence_words,
            )
        )

    return timings


def estimate_sentence_timings(
    original_text: str,
    sentences: list[Sentence],
    total_duration: float,
) -> list[SentenceTiming]:
    """Estimate sentence timings based on character count when Whisper is unavailable."""
    total_chars = len(original_text)
    if total_chars == 0:
        return []

    timings = []
    current_time = 0.0

    for sentence in sentences:
        sentence_duration = (len(sentence.text) / total_chars) * total_duration
        timings.append(
            SentenceTiming(
                sentence_id=sentence.id,
                text=sentence.text,
                start=current_time,
                end=current_time + sentence_duration,
                words=[],
            )
        )
        current_time += sentence_duration

    return timings


async def align_audio_with_text(
    audio_bytes: bytes,
    original_text: str,
    sentences: Optional[list[Sentence]] = None,
    total_duration: Optional[float] = None,
) -> list[SentenceTiming]:
    """Use OpenAI Whisper API to get word-level timestamps and align with original text."""

    # If no sentences provided, create them from original text
    if not sentences:
        sent_pattern = r'(?<=[.!?])\s+'
        sent_texts = re.split(sent_pattern, original_text)
        sentences = []
        char_pos = 0
        for i, text in enumerate(sent_texts):
            text = text.strip()
            if text:
                sentences.append(
                    Sentence(
                        id=f"s{i}",
                        text=text,
                        start_char=char_pos,
                        end_char=char_pos + len(text),
                    )
                )
                char_pos += len(text) + 1

    # Try to use OpenAI Whisper API for accurate timestamps
    if settings.openai_api_key:
        try:
            client = OpenAI(api_key=settings.openai_api_key)

            # Save audio to temp file
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
                f.write(audio_bytes)
                temp_path = f.name

            try:
                # Use OpenAI Whisper API with word-level timestamps
                with open(temp_path, "rb") as audio_file:
                    response = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=audio_file,
                        response_format="verbose_json",
                        timestamp_granularities=["word"],
                    )

                # Extract word timings from response
                words = []
                if hasattr(response, 'words') and response.words:
                    for word_data in response.words:
                        words.append({
                            "word": word_data.word,
                            "start": word_data.start,
                            "end": word_data.end,
                        })

                if words:
                    return align_words_to_sentences(words, sentences)

            finally:
                os.unlink(temp_path)

        except Exception as e:
            print(f"Whisper API error, falling back to estimation: {e}")

    # Fallback: estimate timings based on character count
    if total_duration:
        return estimate_sentence_timings(original_text, sentences, total_duration)

    # If no duration provided, use a rough estimate (150 words per minute)
    word_count = len(original_text.split())
    estimated_duration = (word_count / 150) * 60
    return estimate_sentence_timings(original_text, sentences, estimated_duration)
