from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
import base64
import hashlib
import asyncio
from typing import AsyncGenerator

from app.models.schemas import TTSRequest, TTSResponse, TTSTimingRequest, SentenceTiming
from app.services.tts_service import generate_speech, get_audio_duration
from app.services.whisper_service import align_audio_with_text
from app.config import get_settings

router = APIRouter()
settings = get_settings()

# In-memory cache for recently generated audio (LRU-like)
_audio_cache: dict[str, tuple[bytes, str, float]] = {}
_cache_max_size = 50


def _get_cache_key(text: str, voice: str, speed: float) -> str:
    """Generate a cache key for the request."""
    content = f"{text}:{voice}:{speed}"
    return hashlib.md5(content.encode()).hexdigest()


def _cache_audio(key: str, audio: bytes, content_type: str, duration: float) -> None:
    """Cache audio with simple LRU eviction."""
    global _audio_cache
    if len(_audio_cache) >= _cache_max_size:
        # Remove oldest entry
        oldest_key = next(iter(_audio_cache))
        del _audio_cache[oldest_key]
    _audio_cache[key] = (audio, content_type, duration)


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
    """Generate speech audio from text with caching."""
    check_api_key()

    if len(request.text) > 4096:
        raise HTTPException(
            status_code=400,
            detail="Text too long. Maximum 4096 characters per request.",
        )

    # Check cache first
    cache_key = _get_cache_key(request.text, request.voice.value, request.speed)
    if cache_key in _audio_cache:
        audio_bytes, content_type, duration = _audio_cache[cache_key]
        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
        return {
            "audio_base64": audio_base64,
            "duration": duration,
            "content_type": content_type,
            "cached": True,
        }

    audio_bytes, content_type = await generate_speech(
        text=request.text,
        voice=request.voice.value,
        speed=request.speed,
    )

    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    duration = get_audio_duration(audio_bytes, content_type)

    # Cache the result
    _cache_audio(cache_key, audio_bytes, content_type, duration)

    return {
        "audio_base64": audio_base64,
        "duration": duration,
        "content_type": content_type,
        "cached": False,
    }


@router.post("/generate-with-timing", response_model=TTSResponse)
async def generate_tts_with_timing(request: TTSRequest):
    """Generate speech and return word/sentence level timing with caching."""
    check_api_key()

    if len(request.text) > 4096:
        raise HTTPException(
            status_code=400,
            detail="Text too long. Maximum 4096 characters per request.",
        )

    # Check cache first for audio
    cache_key = _get_cache_key(request.text, request.voice.value, request.speed)
    cached_audio = _audio_cache.get(cache_key)

    if cached_audio:
        audio_bytes, content_type, duration = cached_audio
    else:
        audio_bytes, content_type = await generate_speech(
            text=request.text,
            voice=request.voice.value,
            speed=request.speed,
        )
        duration = get_audio_duration(audio_bytes, content_type)
        _cache_audio(cache_key, audio_bytes, content_type, duration)

    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

    # Get timing data using Whisper alignment
    timings = await align_audio_with_text(audio_bytes, request.text, total_duration=duration)

    return TTSResponse(
        audio_base64=audio_base64,
        duration=duration,
        timings=timings,
        content_type=content_type,
    )


@router.post("/stream")
async def stream_tts(request: TTSRequest):
    """
    Stream audio directly for lower latency playback.
    Returns audio as a streaming response with proper headers.
    """
    check_api_key()

    if len(request.text) > 4096:
        raise HTTPException(
            status_code=400,
            detail="Text too long. Maximum 4096 characters per request.",
        )

    # Check cache first
    cache_key = _get_cache_key(request.text, request.voice.value, request.speed)
    if cache_key in _audio_cache:
        audio_bytes, content_type, _ = _audio_cache[cache_key]
        return Response(
            content=audio_bytes,
            media_type=content_type,
            headers={
                "Content-Length": str(len(audio_bytes)),
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=3600",
            }
        )

    audio_bytes, content_type = await generate_speech(
        text=request.text,
        voice=request.voice.value,
        speed=request.speed,
    )

    duration = get_audio_duration(audio_bytes, content_type)
    _cache_audio(cache_key, audio_bytes, content_type, duration)

    return Response(
        content=audio_bytes,
        media_type=content_type,
        headers={
            "Content-Length": str(len(audio_bytes)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }
    )


@router.post("/batch-generate")
async def batch_generate_tts(requests: list[TTSRequest]):
    """
    Generate multiple audio segments in parallel for reduced latency.
    Useful for prefetching multiple paragraphs at once.
    """
    check_api_key()

    if len(requests) > 10:
        raise HTTPException(
            status_code=400,
            detail="Maximum 10 segments per batch request.",
        )

    async def generate_single(req: TTSRequest, index: int):
        if len(req.text) > 4096:
            return {"index": index, "error": "Text too long"}

        cache_key = _get_cache_key(req.text, req.voice.value, req.speed)
        if cache_key in _audio_cache:
            audio_bytes, content_type, duration = _audio_cache[cache_key]
            audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
            return {
                "index": index,
                "audio_base64": audio_base64,
                "duration": duration,
                "content_type": content_type,
                "cached": True,
            }

        try:
            audio_bytes, content_type = await generate_speech(
                text=req.text,
                voice=req.voice.value,
                speed=req.speed,
            )
            audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
            duration = get_audio_duration(audio_bytes, content_type)
            _cache_audio(cache_key, audio_bytes, content_type, duration)

            return {
                "index": index,
                "audio_base64": audio_base64,
                "duration": duration,
                "content_type": content_type,
                "cached": False,
            }
        except Exception as e:
            return {"index": index, "error": str(e)}

    # Generate all segments in parallel
    tasks = [generate_single(req, i) for i, req in enumerate(requests)]
    results = await asyncio.gather(*tasks)

    return {"segments": results}


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
