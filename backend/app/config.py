from pydantic_settings import BaseSettings
from functools import lru_cache
from typing import Literal


class Settings(BaseSettings):
    app_name: str = "Listenify API"
    debug: bool = True

    # API Keys
    openai_api_key: str = ""
    groq_api_key: str = ""

    # TTS Provider: "openai" or "groq"
    tts_provider: Literal["openai", "groq"] = "groq"

    # TTS Settings
    default_voice: str = "alloy"  # OpenAI: alloy, echo, fable, onyx, nova, shimmer
    default_groq_voice: str = "autumn"  # Groq voices: autumn, diana, hannah, austin, daniel, troy
    default_speed: float = 1.0

    # File upload limits
    max_file_size_mb: int = 50
    allowed_extensions: list[str] = ["pdf", "epub"]

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()
