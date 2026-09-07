/**
 * Turning an uploaded CV into text, in the browser.
 *
 * Three formats, three mechanisms, no build step:
 *
 *   .txt / .md   read directly
 *   .docx        a ZIP containing word/document.xml. Unpacked here with about
 *                sixty lines of ZIP reading and the platform's own
 *                DecompressionStream — no library, no CDN, no supply chain.
 *   .pdf         pdf.js, loaded from a pinned CDN build on demand. It is
 *                roughly a megabyte, so it is imported the first time someone
 *                actually uploads a PDF and never on page load.
 *
 * What this cannot do: a scanned CV. A photograph of a document contains no
 * text, and OCR is a different order of dependency. `looksLikeScannedDocument`
 * in domain/cv.js is what lets the screen say so plainly instead of reporting
 * an empty result as a failure to understand.
 */

const PDFJS_VERSION = '4.6.82';
const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION;

/** A CV is a few pages. Anything much larger is a mistake or an attack. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const READ_ERROR = Object.freeze({
  TOO_LARGE: 'error.file_too_large',
  UNSUPPORTED: 'error.file_unsupported',
  UNREADABLE: 'error.file_unreadable',
});

export class DocumentReadError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DocumentReadError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * ZIP, enough of it to open a .docx
 * ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * Locate the End Of Central Directory record. It sits at the end of the file,
 * but a ZIP comment can follow it, so the last 64KB are scanned backwards.
 */
function findEocd(view) {
  const start = Math.max(0, view.byteLength - 65557);
  for (let i = view.byteLength - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** Every entry in the central directory: name, compression, and where it is. */
function readCentralDirectory(view, bytes) {
  const eocd = findEocd(view);
  if (eocd < 0) throw new DocumentReadError(READ_ERROR.UNREADABLE, 'Not a zip file');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(bytes, view, entry) {
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw new DocumentReadError(READ_ERROR.UNREADABLE, 'Bad local header');
  }
  // The local header repeats the name and extra field, at its own lengths.
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method !== 8) {
    throw new DocumentReadError(READ_ERROR.UNREADABLE, 'Unsupported compression');
  }
  if (typeof DecompressionStream !== 'function') {
    throw new DocumentReadError(READ_ERROR.UNREADABLE, 'No DecompressionStream');
  }

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Word stores the document body as XML. Paragraphs and line breaks become
 * newlines, tabs become spaces, everything else is dropped — we want the
 * words, not the formatting.
 */
function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function readDocx(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const entries = readCentralDirectory(view, bytes);
  const document = entries.find((e) => e.name === 'word/document.xml');
  if (!document) throw new DocumentReadError(READ_ERROR.UNREADABLE, 'No word/document.xml');

  const raw = await readZipEntry(bytes, view, document);
  return docxXmlToText(new TextDecoder().decode(raw));
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_BASE + '/pdf.min.mjs')
      .then((mod) => {
        mod.GlobalWorkerOptions.workerSrc = PDFJS_BASE + '/pdf.worker.min.mjs';
        return mod;
      })
      .catch((err) => {
        // Reset so a later attempt can retry rather than replaying the failure.
        pdfjsPromise = null;
        throw new DocumentReadError(READ_ERROR.UNREADABLE, 'pdf.js failed to load: ' + err.message);
      });
  }
  return pdfjsPromise;
}

async function readPdf(file) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  const pages = [];
  // A CV is short. Capping the pages keeps a 400-page document from freezing
  // the tab, and nobody's relevant experience is on page 26.
  const limit = Math.min(doc.numPages, 25);

  for (let i = 1; i <= limit; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js gives positioned fragments, not lines. `hasEOL` is its own
    // marker for where a visual line ended; without it every CV comes back
    // as one long run-on paragraph and the line heuristics all fail.
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    pages.push(text);
    page.cleanup();
  }

  await doc.destroy();
  return pages.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export const ACCEPTED_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.txt', '.md']);
export const ACCEPT_ATTRIBUTE = '.pdf,.docx,.txt,.md,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

function extensionOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Read an uploaded file to plain text.
 *
 * Throws a DocumentReadError with a translatable code. The caller decides what
 * to do with an empty result — see looksLikeScannedDocument.
 */
export async function readDocument(file) {
  if (!file) throw new DocumentReadError(READ_ERROR.UNREADABLE, 'No file');
  if (file.size > MAX_FILE_BYTES) {
    throw new DocumentReadError(READ_ERROR.TOO_LARGE, 'File too large');
  }

  const extension = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    throw new DocumentReadError(READ_ERROR.UNSUPPORTED, 'Unsupported: ' + extension);
  }

  try {
    if (extension === '.pdf') return await readPdf(file);
    if (extension === '.docx') return await readDocx(file);
    return await file.text();
  } catch (err) {
    if (err instanceof DocumentReadError) throw err;
    throw new DocumentReadError(READ_ERROR.UNREADABLE, err.message);
  }
}
