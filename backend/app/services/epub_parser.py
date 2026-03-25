import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
import re
from uuid import uuid4
from io import BytesIO
from typing import Optional

from app.models.schemas import Chapter, Paragraph, Sentence


def split_into_sentences(text: str) -> list[tuple[str, int, int]]:
    """Split text into sentences with their character positions."""
    pattern = r'(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$'

    sentences = []
    last_end = 0

    for match in re.finditer(pattern, text):
        sentence = text[last_end:match.start() + 1].strip()
        if sentence:
            sentences.append((sentence, last_end, match.start() + 1))
        last_end = match.end()

    remaining = text[last_end:].strip()
    if remaining:
        sentences.append((remaining, last_end, len(text)))

    if not sentences and text.strip():
        sentences.append((text.strip(), 0, len(text)))

    return sentences


def clean_text(text: str) -> str:
    """Clean extracted text from HTML."""
    # Remove extra whitespace
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def extract_paragraphs_from_html(
    html_content: str,
    doc_id: str,
    chapter_idx: int,
) -> list[Paragraph]:
    """Extract paragraphs from EPUB HTML content."""
    soup = BeautifulSoup(html_content, 'html.parser')
    paragraphs = []

    # Remove script and style elements
    for element in soup(['script', 'style', 'nav']):
        element.decompose()

    # Extract headings and paragraphs
    para_idx = 0
    for element in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div']):
        text = clean_text(element.get_text())

        if len(text) < 3:
            continue

        # Determine if heading
        is_heading = element.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
        heading_level = None
        if is_heading:
            heading_level = int(element.name[1])

        # Split into sentences
        sentence_data = split_into_sentences(text)
        sentences = [
            Sentence(
                id=f"{doc_id}-ch{chapter_idx}-p{para_idx}-s{i}",
                text=sent_text,
                start_char=start,
                end_char=end,
            )
            for i, (sent_text, start, end) in enumerate(sentence_data)
        ]

        para_id = f"{doc_id}-ch{chapter_idx}-p{para_idx}"
        paragraphs.append(
            Paragraph(
                id=para_id,
                text=text,
                sentences=sentences,
                is_heading=is_heading,
                heading_level=heading_level,
            )
        )
        para_idx += 1

    return paragraphs


def parse_epub(content: bytes, doc_id: str) -> tuple[list[Chapter], Optional[str]]:
    """Parse an EPUB file and extract structured text with sentences.
    Returns (chapters, cover_image_base64). Cover image is None for EPUB files."""
    book = epub.read_epub(BytesIO(content))

    chapters = []
    chapter_idx = 0

    # Get spine items (reading order)
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            html_content = item.get_content().decode('utf-8', errors='ignore')
            paragraphs = extract_paragraphs_from_html(html_content, doc_id, chapter_idx)

            if paragraphs:
                # Try to get chapter title from first heading
                title = f"Chapter {chapter_idx + 1}"
                for para in paragraphs:
                    if para.is_heading and para.heading_level and para.heading_level <= 2:
                        title = para.text[:100]
                        break

                chapters.append(
                    Chapter(
                        id=f"{doc_id}-ch{chapter_idx}",
                        title=title,
                        paragraphs=paragraphs,
                    )
                )
                chapter_idx += 1

    # If no chapters found, create a default one
    if not chapters:
        chapters = [
            Chapter(
                id=f"{doc_id}-ch0",
                title="Document",
                paragraphs=[],
            )
        ]

    return chapters, None
