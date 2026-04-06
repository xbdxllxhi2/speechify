import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
import re
import base64
from uuid import uuid4
from io import BytesIO
from typing import Optional

from app.models.schemas import Chapter, Paragraph, Sentence


# Patterns to detect non-content text that should be filtered (same as PDF)
SKIP_PATTERNS = [
    r'^page\s*\d+$',
    r'^\d+$',
    r'^copyright\s*[©®]?\s*\d{4}',
    r'^all rights reserved',
    r'^isbn[\s:-]*[\d-]+',
    r'^table of contents$',
    r'^contents$',
]

SKIP_COMPILED = [re.compile(p, re.IGNORECASE) for p in SKIP_PATTERNS]

MIN_PARAGRAPH_WORDS = 3
MIN_PARAGRAPH_CHARS = 15
MIN_SENTENCE_WORDS = 2


def is_skippable_content(text: str) -> bool:
    """Check if text should be skipped."""
    text_clean = text.strip()

    for pattern in SKIP_COMPILED:
        if pattern.match(text_clean):
            return True

    words = text_clean.split()
    if len(words) < MIN_PARAGRAPH_WORDS:
        return True

    if len(text_clean) < MIN_PARAGRAPH_CHARS:
        return True

    return False


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
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def extract_cover_image(book: epub.EpubBook) -> Optional[str]:
    """Extract cover image from EPUB as base64 encoded PNG/JPEG."""
    try:
        # Method 1: Check for cover image in metadata
        cover_id = None
        for meta in book.get_metadata('OPF', 'cover'):
            if meta and len(meta) > 0:
                cover_id = meta[0] if isinstance(meta[0], str) else None
                break

        # Method 2: Look for item with 'cover' in id or properties
        if not cover_id:
            for item in book.get_items():
                item_id = item.get_id() or ''
                if 'cover' in item_id.lower():
                    cover_id = item_id
                    break

        # Method 3: Look for cover in spine or guide
        if not cover_id:
            for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
                name = (item.get_name() or '').lower()
                if 'cover' in name:
                    cover_id = item.get_id()
                    break

        if cover_id:
            cover_item = book.get_item_with_id(cover_id)
            if cover_item:
                content = cover_item.get_content()
                if content:
                    # Determine media type
                    media_type = cover_item.media_type or 'image/jpeg'
                    cover_base64 = base64.b64encode(content).decode('utf-8')
                    print(f"EPUB cover extracted: {len(cover_base64)} chars, type: {media_type}")
                    return cover_base64

        # Method 4: Try first image in the book
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            content = item.get_content()
            if content and len(content) > 1000:  # Skip tiny images
                cover_base64 = base64.b64encode(content).decode('utf-8')
                print(f"EPUB cover (first image): {len(cover_base64)} chars")
                return cover_base64

        print("No cover image found in EPUB")
        return None
    except Exception as e:
        print(f"Failed to extract EPUB cover: {e}")
        return None


def extract_toc(book: epub.EpubBook) -> list[dict]:
    """
    Extract table of contents from EPUB.
    Returns list of {title, href, level} entries.
    """
    toc_entries = []

    def process_toc_item(item, level=1):
        if isinstance(item, tuple):
            # It's a section with nested items
            section, children = item
            if hasattr(section, 'title'):
                toc_entries.append({
                    'title': section.title,
                    'href': getattr(section, 'href', ''),
                    'level': level,
                })
            for child in children:
                process_toc_item(child, level + 1)
        elif hasattr(item, 'title'):
            # It's a simple link
            toc_entries.append({
                'title': item.title,
                'href': getattr(item, 'href', ''),
                'level': level,
            })

    try:
        toc = book.toc
        if toc:
            for item in toc:
                process_toc_item(item)
            print(f"Extracted {len(toc_entries)} TOC entries from EPUB")
    except Exception as e:
        print(f"Failed to extract TOC: {e}")

    return toc_entries


def extract_paragraphs_from_html(
    html_content: str,
    doc_id: str,
    chapter_idx: int,
    purge_content: bool = True,
) -> list[Paragraph]:
    """Extract paragraphs from EPUB HTML content."""
    soup = BeautifulSoup(html_content, 'html.parser')
    paragraphs = []

    # Remove script, style, and nav elements
    for element in soup(['script', 'style', 'nav', 'aside', 'footer', 'header']):
        element.decompose()

    # Extract headings and paragraphs
    para_idx = 0
    for element in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div']):
        text = clean_text(element.get_text())

        if len(text) < 3:
            continue

        # Apply content purging if enabled
        if purge_content and is_skippable_content(text):
            continue

        # Determine if heading
        is_heading = element.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
        heading_level = None
        if is_heading:
            heading_level = int(element.name[1])

        # Split into sentences
        sentence_data = split_into_sentences(text)

        # Filter short sentences if purging
        if purge_content:
            sentence_data = [
                (s, start, end) for s, start, end in sentence_data
                if len(s.split()) >= MIN_SENTENCE_WORDS
            ]

        if not sentence_data:
            continue

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


def parse_epub(content: bytes, doc_id: str) -> tuple[list[Chapter], Optional[str], list[dict]]:
    """Parse an EPUB file and extract structured text with sentences.
    Returns (chapters, cover_image_base64, toc_entries)."""
    book = epub.read_epub(BytesIO(content))

    # Extract cover image
    cover_image = extract_cover_image(book)

    # Extract table of contents
    toc_entries = extract_toc(book)

    # Build a map of href -> TOC title for better chapter naming
    href_to_title = {}
    for entry in toc_entries:
        href = entry.get('href', '')
        # Normalize href (remove anchors)
        base_href = href.split('#')[0] if href else ''
        if base_href and entry.get('title'):
            href_to_title[base_href] = entry['title']

    chapters = []
    chapter_idx = 0

    # Get spine items (reading order)
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            item_name = item.get_name() or ''
            html_content = item.get_content().decode('utf-8', errors='ignore')
            paragraphs = extract_paragraphs_from_html(html_content, doc_id, chapter_idx, purge_content=True)

            if paragraphs:
                # Try to get chapter title from TOC first
                title = None

                # Check TOC map
                base_name = item_name.split('#')[0]
                if base_name in href_to_title:
                    title = href_to_title[base_name]

                # Fallback: use first heading
                if not title:
                    for para in paragraphs:
                        if para.is_heading and para.heading_level and para.heading_level <= 2:
                            title = para.text[:100]
                            break

                # Final fallback
                if not title:
                    title = f"Chapter {chapter_idx + 1}"

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

    print(f"EPUB parsed: {len(chapters)} chapters, {sum(len(c.paragraphs) for c in chapters)} paragraphs")

    return chapters, cover_image, toc_entries
