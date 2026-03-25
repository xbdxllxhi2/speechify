import fitz  # PyMuPDF
import re
import base64
from uuid import uuid4
from typing import Optional
from io import BytesIO

from app.models.schemas import Chapter, Paragraph, Sentence


def extract_cover_image(content: bytes) -> Optional[str]:
    """Extract first page of PDF as base64 encoded PNG thumbnail."""
    try:
        doc = fitz.open(stream=content, filetype="pdf")
        if len(doc) == 0:
            print("PDF has no pages")
            return None

        # Get first page
        page = doc[0]

        # Render page to image (PNG format)
        # Use a reasonable zoom level for good quality thumbnail
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        image_bytes = pix.tobytes("png")  # Get PNG-encoded bytes

        # Convert to base64
        cover_image = base64.b64encode(image_bytes).decode('utf-8')
        print(f"Cover image extracted successfully, length: {len(cover_image)}")
        doc.close()
        return cover_image
    except Exception as e:
        print(f"Failed to extract cover image: {e}")
        import traceback
        traceback.print_exc()
        return None


def split_into_sentences(text: str) -> list[tuple[str, int, int]]:
    """Split text into sentences with their character positions."""
    # Regex pattern for sentence boundaries
    pattern = r'(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$'

    sentences = []
    last_end = 0

    for match in re.finditer(pattern, text):
        sentence = text[last_end:match.start() + 1].strip()
        if sentence:
            sentences.append((sentence, last_end, match.start() + 1))
        last_end = match.end()

    # Add remaining text as last sentence
    remaining = text[last_end:].strip()
    if remaining:
        sentences.append((remaining, last_end, len(text)))

    # If no sentences found, treat entire text as one sentence
    if not sentences and text.strip():
        sentences.append((text.strip(), 0, len(text)))

    return sentences


def extract_paragraphs_from_page(
    page: fitz.Page,
    doc_id: str,
    page_num: int,
) -> list[Paragraph]:
    """Extract paragraphs from a PDF page, handling multi-column layouts."""
    paragraphs = []

    # Get text blocks with position info
    blocks = page.get_text("dict")["blocks"]

    text_blocks = []
    for block in blocks:
        if block["type"] == 0:  # Text block
            block_text = ""
            for line in block.get("lines", []):
                line_text = ""
                for span in line.get("spans", []):
                    line_text += span.get("text", "")
                block_text += line_text + " "

            block_text = block_text.strip()
            if block_text:
                bbox = block["bbox"]
                text_blocks.append({
                    "text": block_text,
                    "x0": bbox[0],
                    "y0": bbox[1],
                    "x1": bbox[2],
                    "y1": bbox[3],
                })

    if not text_blocks:
        return paragraphs

    # Detect columns by analyzing x-coordinates
    page_width = page.rect.width
    mid_x = page_width / 2

    # Sort blocks: first by column (left/right), then by y position
    left_blocks = [b for b in text_blocks if b["x1"] < mid_x + 50]
    right_blocks = [b for b in text_blocks if b["x0"] > mid_x - 50]

    # If significant overlap, treat as single column
    if len(left_blocks) > 0 and len(right_blocks) > 0:
        left_xs = [b["x1"] for b in left_blocks]
        right_xs = [b["x0"] for b in right_blocks]
        if max(left_xs) > min(right_xs):
            # Single column layout
            sorted_blocks = sorted(text_blocks, key=lambda b: (b["y0"], b["x0"]))
        else:
            # Multi-column: read left column first, then right
            left_sorted = sorted(left_blocks, key=lambda b: b["y0"])
            right_sorted = sorted(right_blocks, key=lambda b: b["y0"])
            sorted_blocks = left_sorted + right_sorted
    else:
        sorted_blocks = sorted(text_blocks, key=lambda b: (b["y0"], b["x0"]))

    # Convert blocks to paragraphs
    for block in sorted_blocks:
        text = block["text"]
        if len(text) < 3:  # Skip very short text
            continue

        # Detect if this might be a heading (short, potentially bold)
        is_heading = len(text) < 100 and not text.endswith(".")
        heading_level = 1 if is_heading and len(text) < 50 else (2 if is_heading else None)

        # Split into sentences
        sentence_data = split_into_sentences(text)
        sentences = [
            Sentence(
                id=f"{doc_id}-p{page_num}-s{i}",
                text=sent_text,
                start_char=start,
                end_char=end,
            )
            for i, (sent_text, start, end) in enumerate(sentence_data)
        ]

        para_id = f"{doc_id}-p{page_num}-{str(uuid4())[:8]}"
        paragraphs.append(
            Paragraph(
                id=para_id,
                text=text,
                sentences=sentences,
                page=page_num + 1,  # 1-indexed for display
                is_heading=is_heading,
                heading_level=heading_level,
            )
        )

    return paragraphs


def parse_pdf(content: bytes, doc_id: str) -> tuple[list[Chapter], Optional[str]]:
    """Parse a PDF file and extract structured text with sentences.
    Returns (chapters, cover_image_base64)."""
    # Extract cover image first
    cover_image = extract_cover_image(content)

    doc = fitz.open(stream=content, filetype="pdf")

    # For PDFs without chapters, create a single chapter
    all_paragraphs = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        paragraphs = extract_paragraphs_from_page(page, doc_id, page_num)
        all_paragraphs.extend(paragraphs)

    doc.close()

    # Try to detect chapters from headings
    chapters = []
    current_chapter_paragraphs = []
    current_chapter_title = "Document"

    for para in all_paragraphs:
        if para.is_heading and para.heading_level == 1:
            # Start new chapter if we have content
            if current_chapter_paragraphs:
                chapters.append(
                    Chapter(
                        id=f"{doc_id}-ch{len(chapters)}",
                        title=current_chapter_title,
                        paragraphs=current_chapter_paragraphs,
                    )
                )
            current_chapter_title = para.text[:100]  # Truncate long titles
            current_chapter_paragraphs = [para]
        else:
            current_chapter_paragraphs.append(para)

    # Add final chapter
    if current_chapter_paragraphs:
        chapters.append(
            Chapter(
                id=f"{doc_id}-ch{len(chapters)}",
                title=current_chapter_title,
                paragraphs=current_chapter_paragraphs,
            )
        )

    # If no chapters detected, wrap everything in one
    if not chapters:
        chapters = [
            Chapter(
                id=f"{doc_id}-ch0",
                title="Document",
                paragraphs=all_paragraphs,
            )
        ]

    return chapters, cover_image
