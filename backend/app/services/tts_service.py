from openai import AsyncOpenAI
from groq import AsyncGroq
from io import BytesIO

from app.config import get_settings

settings = get_settings()


def get_openai_client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key)


def get_groq_client() -> AsyncGroq:
    return AsyncGroq(api_key=settings.groq_api_key)


# Available Groq voices (fetched from API)
GROQ_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"]

# Default voice for each provider
DEFAULT_OPENAI_VOICE = "alloy"
DEFAULT_GROQ_VOICE = "autumn"  # First available Groq voice


async def generate_speech_openai(
    text: str,
    voice: str = "alloy",
    speed: float = 1.0,
) -> bytes:
    """Generate speech audio using OpenAI TTS API."""
    client = get_openai_client()

    response = await client.audio.speech.create(
        model="tts-1",
        voice=voice,
        input=text,
        speed=speed,
        response_format="mp3",
    )

    return response.content


async def generate_speech_groq(
    text: str,
    voice: str = DEFAULT_GROQ_VOICE,
    speed: float = 1.0,
) -> bytes:
    """Generate speech audio using Groq TTS API (Orpheus model)."""
    client = get_groq_client()

    # Use the voice directly if it's a valid Groq voice, otherwise use default
    groq_voice = voice if voice in GROQ_VOICES else DEFAULT_GROQ_VOICE

    response = await client.audio.speech.create(
        model="canopylabs/orpheus-v1-english",  # New Orpheus model
        voice=groq_voice,
        input=text,
        response_format="wav",
    )

    # Groq returns AsyncBinaryAPIResponse - use read() method to get bytes
    return await response.read()


async def generate_speech(
    text: str,
    voice: str = "alloy",
    speed: float = 1.0,
) -> tuple[bytes, str]:
    """Generate speech using configured TTS provider. Returns (audio_bytes, content_type)."""
    if settings.tts_provider == "groq" and settings.groq_api_key:
        audio = await generate_speech_groq(text, voice, speed)
        return audio, "audio/wav"
    else:
        audio = await generate_speech_openai(text, voice, speed)
        return audio, "audio/mp3"


def get_audio_duration(audio_bytes: bytes, content_type: str = "audio/mp3") -> float:
    """Estimate audio duration based on file size and format."""
    if content_type == "audio/wav":
        # WAV: 16-bit, 24kHz mono = 48000 bytes per second
        # Subtract 44 bytes for WAV header
        audio_data_size = len(audio_bytes) - 44
        bytes_per_second = 48000  # 24kHz * 2 bytes (16-bit)
        duration = audio_data_size / bytes_per_second
    else:
        # MP3: Estimate based on ~128kbps bitrate
        file_size_bits = len(audio_bytes) * 8
        bitrate = 128000  # 128 kbps
        duration = file_size_bits / bitrate

    return round(max(0, duration), 2)
