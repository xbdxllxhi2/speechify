from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
import base64

from app.models.schemas import TTSRequest, TTSResponse, TTSTimingRequest, SentenceTiming
from app.services.tts_service import generate_speech, get_audio_duration
from app.services.whisper_service import align_audio_with_text
from app.config import get_settings

router = APIRouter()
settings = get_settings()


def check_api_key():
    """Check if the required API key is configured."""
    if settings.tts_provider == "groq":
        if not settings.groq_api_key:
            raise HTTPException(
                status_code=500,
                detail="Groq API key not configured. Set GROQ_API_KEY in .env",
            )
    else:
        if not settings.openai_api_key:
            raise HTTPException(
                status_code=500,
                detail="OpenAI API key not configured. Set OPENAI_API_KEY in .env",
            )


@router.post("/generate")
async def generate_tts(request: TTSRequest):
    """Generate speech audio from text."""
    check_api_key()

    if len(request.text) > 4096:
        raise HTTPException(
            status_code=400,
            detail="Text too long. Maximum 4096 characters per request.",
        )

    audio_bytes, content_type = await generate_speech(
        text=request.text,
        voice=request.voice.value,
        speed=request.speed,
    )

    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    duration = get_audio_duration(audio_bytes, content_type)

    return {
        "audio_base64": audio_base64,
        "duration": duration,
        "content_type": content_type,
    }


@router.post("/generate-with-timing", response_model=TTSResponse)
async def generate_tts_with_timing(request: TTSRequest):
    """Generate speech and return word/sentence level timing."""
    check_api_key()

    audio_bytes, content_type = await generate_speech(
        text=request.text,
        voice=request.voice.value,
        speed=request.speed,
    )

    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    duration = get_audio_duration(audio_bytes, content_type)

    # Get timing data using Whisper alignment
    timings = await align_audio_with_text(audio_bytes, request.text, total_duration=duration)

    return TTSResponse(
        audio_base64=audio_base64,
        duration=duration,
        timings=timings,
        content_type=content_type,
    )


@router.post("/timing", response_model=list[SentenceTiming])
async def get_timing(request: TTSTimingRequest):
    """Get word-level timing for existing audio."""

    audio_bytes = base64.b64decode(request.audio_base64)
    timings = await align_audio_with_text(
        audio_bytes,
        request.original_text,
        request.sentences,
    )
    return timings


@router.get("/voices")
async def list_voices():
    """List available TTS voices based on configured provider."""
    if settings.tts_provider == "groq":
        return {
            "provider": "groq",
            "voices": [
                {"id": "autumn", "name": "Autumn", "description": "Warm and natural"},
                {"id": "diana", "name": "Diana", "description": "Clear and crisp"},
                {"id": "hannah", "name": "Hannah", "description": "Friendly and approachable"},
                {"id": "austin", "name": "Austin", "description": "Smooth and professional"},
                {"id": "daniel", "name": "Daniel", "description": "Deep and rich"},
                {"id": "troy", "name": "Troy", "description": "Strong and confident"},
            ]
        }
    else:
        return {
            "provider": "openai",
            "voices": [
                {"id": "alloy", "name": "Alloy", "description": "Neutral and balanced"},
                {"id": "echo", "name": "Echo", "description": "Warm and conversational"},
                {"id": "fable", "name": "Fable", "description": "Expressive and dynamic"},
                {"id": "onyx", "name": "Onyx", "description": "Deep and authoritative"},
                {"id": "nova", "name": "Nova", "description": "Friendly and upbeat"},
                {"id": "shimmer", "name": "Shimmer", "description": "Clear and gentle"},
            ]
        }


@router.get("/provider")
async def get_provider():
    """Get current TTS provider info."""
    return {
        "provider": settings.tts_provider,
        "configured": bool(
            settings.groq_api_key if settings.tts_provider == "groq" else settings.openai_api_key
        ),
    }
