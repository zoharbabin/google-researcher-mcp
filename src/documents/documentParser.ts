/**
 * Document Parser Module
 *
 * Parses PDF, DOCX, and PPTX documents from URLs, extracting text content.
 */

import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';
import {
  DocumentType,
  DocumentParseErrorType,
  type DocumentParseResult,
  type DocumentParseOptions,
  type DocumentMetadata,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_TIMEOUT,
} from './types.js';
import { logger } from '../shared/logger.js';
import { ssrfSafeFetch, SSRFProtectionError } from '../shared/urlValidator.js';

// ── Type Detection ─────────────────────────────────────────────────────────

/**
 * Detects document type from URL and optional Content-Type header.
 *
 * @param url - Document URL
 * @param contentType - Optional Content-Type header value
 * @returns Detected document type
 */
export function detectDocumentType(
  url: string,
  contentType?: string
): DocumentType {
  // 1. Check Content-Type header first (most reliable)
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('pdf') || ct.includes('application/pdf')) {
      return DocumentType.PDF;
    }
    if (ct.includes('wordprocessingml') || ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml')) {
      return DocumentType.DOCX;
    }
    if (ct.includes('presentationml') || ct.includes('application/vnd.openxmlformats-officedocument.presentationml')) {
      return DocumentType.PPTX;
    }
  }

  // 2. Check URL extension (fallback)
  try {
    const urlPath = new URL(url).pathname.toLowerCase();
    const ext = urlPath.split('.').pop();

    switch (ext) {
      case 'pdf':
        return DocumentType.PDF;
      case 'docx':
        return DocumentType.DOCX;
      case 'pptx':
        return DocumentType.PPTX;
      default:
        return DocumentType.UNKNOWN;
    }
  } catch {
    return DocumentType.UNKNOWN;
  }
}

/**
 * Checks if a URL points to a supported document type.
 */
export function isDocumentUrl(url: string): boolean {
  return detectDocumentType(url) !== DocumentType.UNKNOWN;
}

// ── Document Fetching ──────────────────────────────────────────────────────

/**
 * Fetches document from URL as ArrayBuffer with size and timeout limits.
 */
async function fetchDocument(
  url: string,
  options: DocumentParseOptions
): Promise<{ buffer: Buffer; contentType?: string }> {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const response = await ssrfSafeFetch(url, {}, {
    signal: AbortSignal.timeout(timeout),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DocumentParser/1.0)',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Check Content-Length if available (pre-download guard)
  const contentLength = response.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > maxFileSize) {
    throw new Error(`File too large: ${contentLength} bytes exceeds ${maxFileSize} byte limit`);
  }

  // Stream the body with a size limit to avoid OOM on large responses
  // that don't declare Content-Length
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxFileSize) {
        throw new Error(`File too large: exceeds ${maxFileSize} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Single Buffer allocation from chunks (avoids double-copy)
  const buffer = Buffer.concat(chunks, totalBytes);

  return {
    buffer,
    contentType: response.headers.get('Content-Type') ?? undefined,
  };
}

// ── PDF Parsing ────────────────────────────────────────────────────────────

/**
 * Parses PDF document and extracts text using pdf-parse v2 API.
 */
async function parsePdf(buffer: Buffer): Promise<{ text: string; metadata: DocumentMetadata }> {
  const parser = new PDFParse({ data: buffer });

  try {
    // Get text content
    const textResult = await parser.getText();

    // Get metadata
    let info;
    try {
      info = await parser.getInfo();
    } catch {
      // Info extraction is optional, don't fail if it errors
    }

    return {
      text: textResult.text.trim(),
      metadata: {
        pageCount: textResult.pages?.length,
        title: info?.info?.Title,
        author: info?.info?.Author,
      },
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ── DOCX Parsing ───────────────────────────────────────────────────────────

/**
 * Parses DOCX document and extracts text.
 */
async function parseDocx(buffer: Buffer): Promise<{ text: string; metadata: DocumentMetadata }> {
  const result = await mammoth.extractRawText({ buffer });

  return {
    text: result.value.trim(),
    metadata: {},
  };
}

// ── PPTX Parsing ───────────────────────────────────────────────────────────

/**
 * Parses PPTX document and extracts text from slides.
 */
async function parsePptx(buffer: Buffer): Promise<{ text: string; metadata: DocumentMetadata }> {
  const zip = await JSZip.loadAsync(buffer);
  const textParts: string[] = [];
  let slideCount = 0;

  // Find all slide files (ppt/slides/slide1.xml, slide2.xml, etc.)
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? '0');
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? '0');
      return numA - numB;
    });

  for (const slidePath of slideFiles) {
    const slideXml = await zip.file(slidePath)?.async('string');
    if (slideXml) {
      slideCount++;
      // Extract text from XML using regex (simple approach)
      // Matches <a:t>text</a:t> which is how PowerPoint stores text
      const textMatches = slideXml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
      const slideText = textMatches
        .map(match => match.replace(/<a:t>|<\/a:t>/g, ''))
        .join(' ');

      if (slideText.trim()) {
        textParts.push(`[Slide ${slideCount}]\n${slideText.trim()}`);
      }
    }
  }

  return {
    text: textParts.join('\n\n'),
    metadata: {
      pageCount: slideCount,
    },
  };
}

// ── Main Parser ────────────────────────────────────────────────────────────

/**
 * Parses a document from a URL.
 *
 * @param url - Document URL
 * @param options - Parsing options
 * @returns Parse result with content or error
 */
export async function parseDocument(
  url: string,
  options: DocumentParseOptions = {}
): Promise<DocumentParseResult> {
  const startTime = Date.now();

  try {
    // Fetch the document (returns Buffer directly — no double copy)
    const { buffer: nodeBuffer, contentType } = await fetchDocument(url, options);

    // Detect document type
    const documentType = detectDocumentType(url, contentType);

    if (documentType === DocumentType.UNKNOWN) {
      return {
        success: false,
        documentType,
        error: {
          type: DocumentParseErrorType.UNSUPPORTED_FORMAT,
          message: `Unsupported document format for URL: ${url}`,
        },
      };
    }

    // Parse based on type
    let text: string;
    let metadata: DocumentMetadata = { fileSize: nodeBuffer.byteLength };

    try {
      switch (documentType) {
        case DocumentType.PDF:
          const pdfResult = await parsePdf(nodeBuffer);
          text = pdfResult.text;
          metadata = { ...metadata, ...pdfResult.metadata };
          break;

        case DocumentType.DOCX:
          const docxResult = await parseDocx(nodeBuffer);
          text = docxResult.text;
          metadata = { ...metadata, ...docxResult.metadata };
          break;

        case DocumentType.PPTX:
          const pptxResult = await parsePptx(nodeBuffer);
          text = pptxResult.text;
          metadata = { ...metadata, ...pptxResult.metadata };
          break;

        default:
          return {
            success: false,
            documentType,
            error: {
              type: DocumentParseErrorType.UNSUPPORTED_FORMAT,
              message: `No parser available for type: ${documentType}`,
            },
          };
      }
    } catch (parseError) {
      const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);

      // Check for specific error types
      if (errorMessage.toLowerCase().includes('password')) {
        return {
          success: false,
          documentType,
          error: {
            type: DocumentParseErrorType.PASSWORD_PROTECTED,
            message: 'Document is password protected',
          },
        };
      }

      if (errorMessage.toLowerCase().includes('corrupt') || errorMessage.toLowerCase().includes('invalid')) {
        return {
          success: false,
          documentType,
          error: {
            type: DocumentParseErrorType.CORRUPTED_FILE,
            message: 'Document appears to be corrupted or invalid',
            details: errorMessage,
          },
        };
      }

      return {
        success: false,
        documentType,
        error: {
          type: DocumentParseErrorType.EXTRACTION_FAILED,
          message: 'Failed to extract text from document',
          details: errorMessage,
        },
      };
    }

    // Return success
    const elapsed = Date.now() - startTime;
    logger.debug('Document parsed successfully', {
      url,
      documentType,
      contentLength: text.length,
      elapsed,
    });

    return {
      success: true,
      content: text,
      documentType,
      metadata: options.extractMetadata !== false ? metadata : undefined,
    };
  } catch (fetchError) {
    const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);

    // Check for SSRF protection error
    if (fetchError instanceof SSRFProtectionError) {
      return {
        success: false,
        documentType: DocumentType.UNKNOWN,
        error: {
          type: DocumentParseErrorType.NETWORK_ERROR,
          message: `URL blocked by security policy: ${errorMessage}`,
        },
      };
    }

    // Check for size limit error
    if (errorMessage.includes('too large')) {
      return {
        success: false,
        documentType: DocumentType.UNKNOWN,
        error: {
          type: DocumentParseErrorType.FILE_TOO_LARGE,
          message: errorMessage,
        },
      };
    }

    // Network/fetch error
    return {
      success: false,
      documentType: DocumentType.UNKNOWN,
      error: {
        type: DocumentParseErrorType.NETWORK_ERROR,
        message: `Failed to fetch document: ${errorMessage}`,
      },
    };
  }
}
