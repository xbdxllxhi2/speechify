from fastapi import APIRouter, UploadFile, File, HTTPException
from uuid import uuid4
from datetime import datetime

from app.models.schemas import ParsedDocument, DocumentType, DocumentClassification, TOCEntry
from app.services.pdf_parser import parse_pdf
from app.services.epub_parser import parse_epub
from app.config import get_settings

router = APIRouter()
settings = get_settings()


def get_file_extension(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


@router.post("/parse", response_model=ParsedDocument)
async def parse_document(file: UploadFile = File(...)):
    """Parse a PDF or EPUB file and return structured text with sentences."""

    extension = get_file_extension(file.filename or "")

    if extension not in settings.allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {settings.allowed_extensions}",
        )

    content = await file.read()

    if len(content) > settings.max_file_size_mb * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size: {settings.max_file_size_mb}MB",
        )

    doc_id = str(uuid4())
    classification = DocumentClassification.DOCUMENT
    toc_entries: list[TOCEntry] = []

    if extension == "pdf":
        chapters, cover_image, doc_classification = parse_pdf(content, doc_id)
        doc_type = DocumentType.PDF
        classification = DocumentClassification(doc_classification)
        # Generate TOC from chapters for PDFs
        toc_entries = [
            TOCEntry(title=ch.title, href=f"#chapter-{i}", level=1)
            for i, ch in enumerate(chapters)
        ]
    else:
        chapters, cover_image, epub_toc = parse_epub(content, doc_id)
        doc_type = DocumentType.EPUB
        classification = DocumentClassification.BOOK
        # Use extracted TOC from EPUB
        toc_entries = [
            TOCEntry(title=entry['title'], href=entry.get('href', ''), level=entry.get('level', 1))
            for entry in epub_toc
        ]

    total_chars = sum(len(p.text) for c in chapters for p in c.paragraphs)
    total_sentences = sum(len(p.sentences) for c in chapters for p in c.paragraphs)

    title = file.filename.rsplit(".", 1)[0] if file.filename else "Untitled"

    return ParsedDocument(
        id=doc_id,
        title=title,
        type=doc_type,
        classification=classification,
        chapters=chapters,
        toc=toc_entries,
        total_characters=total_chars,
        total_sentences=total_sentences,
        created_at=datetime.now(),
        cover_image=cover_image,
    )
