from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import documents, tts

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    description="Transform documents into premium audio experiences",
    version="1.0.0",
)

# CORS middleware for Angular frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(documents.router, prefix="/api/documents", tags=["Documents"])
app.include_router(tts.router, prefix="/api/tts", tags=["Text-to-Speech"])


@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "app": settings.app_name}
