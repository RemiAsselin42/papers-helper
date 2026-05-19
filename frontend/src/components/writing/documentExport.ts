/**
 * Client-side document export. TXT/HTML are written as plain Blobs, DOCX is a
 * Word-compatible HTML file (`.doc`), and PDF is rendered with paged.js — a CSS
 * paged-media polyfill that lays the content out into real A4 pages with a
 * numbered footer, then hands those pages to the browser's print dialog.
 */

export type ExportFormat = 'pdf' | 'docx' | 'html' | 'txt'

/**
 * The paged.js polyfill is vendored into `public/` (the `pagedjs` package
 * blocks deep `exports` paths, so it cannot be imported as an asset). It is
 * served at the site root and runs as a classic script inside the print
 * iframe. The copy is kept in sync from `node_modules/pagedjs/dist/` by
 * `scripts/copy-pagedjs.mjs`, which runs automatically on `prebuild`.
 */
const PAGED_POLYFILL_URL = '/paged.polyfill.min.js'

export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'pdf', label: 'PDF', hint: 'Pages A4 numérotées, via la fenêtre d’impression' },
  { id: 'docx', label: 'Word', hint: 'Fichier .doc compatible Word / Google Docs' },
  { id: 'html', label: 'Page web', hint: 'Fichier .html autonome' },
  { id: 'txt', label: 'Texte brut', hint: 'Fichier .txt sans mise en forme' },
]

/** Turn a document title into a safe-ish file name stem. */
export function slugify(title: string): string {
  const stem = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return stem || 'document'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * tiptap serialises empty paragraphs as `<p></p>`, which collapse to zero
 * height outside the editor (the editor only shows them thanks to a display-
 * only trailing `<br>`). Without this, consecutive blank lines vanish on export
 * and the content below shifts up. Re-insert a `<br>` so each blank line keeps
 * its height — in browsers (HTML/PDF) and in Word (DOCX) alike.
 */
function fillEmptyParagraphs(html: string): string {
  return html.replace(/<p([^>]*)>\s*<\/p>/g, '<p$1><br></p>')
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** A standalone, lightly-styled HTML document — used for HTML export and print. */
function htmlDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt;
         line-height: 1.5; color: #1a1a1a; max-width: 21cm; margin: 2.5cm auto;
         padding: 0 1cm; }
  h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; }
  p { margin: 0 0 0.6em; }
  @page { margin: 2cm; }
</style>
</head>
<body>${fillEmptyParagraphs(bodyHtml)}</body>
</html>`
}

function exportTxt(title: string, text: string): void {
  triggerDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${slugify(title)}.txt`)
}

function exportHtml(title: string, bodyHtml: string): void {
  triggerDownload(
    new Blob([htmlDocument(title, bodyHtml)], { type: 'text/html;charset=utf-8' }),
    `${slugify(title)}.html`
  )
}

/** Word opens HTML wrapped with the Office namespaces as an editable document. */
function exportDoc(title: string, bodyHtml: string): void {
  const wordHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" \
xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>${fillEmptyParagraphs(bodyHtml)}</body></html>`
  // BOM so Word reads it as UTF-8.
  triggerDownload(
    new Blob(['﻿', wordHtml], { type: 'application/msword' }),
    `${slugify(title)}.doc`
  )
}

/**
 * The print document for PDF export. paged.js reads the `@page` rules — page
 * size, margins, and the `@bottom-center` margin box that prints "n / total".
 * It also sets the print `@page` margin to 0 so the rendered pages map 1:1 to
 * sheets, which is what removes the browser's own header/footer (URL, title,
 * date). `PagedConfig.after` fires once pagination is done, then we print.
 */
function pagedPdfDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page {
    size: A4;
    margin: 2cm;
    @bottom-center {
      content: counter(page) " / " counter(pages);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 9pt;
      color: #555;
    }
  }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt;
         line-height: 1.5; color: #1a1a1a; }
  h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; }
  p { margin: 0 0 0.6em; }
</style>
<script>
  window.PagedConfig = {
    auto: true,
    after: function () { window.focus(); window.print(); },
  };
</script>
<script src="${PAGED_POLYFILL_URL}"></script>
</head>
<body>${fillEmptyParagraphs(bodyHtml)}</body>
</html>`
}

/**
 * Render the document into an off-screen iframe and open the print dialog.
 * The iframe is sized to a full A4 page so paged.js can measure layout (a 0×0
 * frame would collapse line widths and mis-paginate).
 */
function exportPdf(title: string, bodyHtml: string): void {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:21cm;height:29.7cm;border:0'
  iframe.onload = () => {
    const win = iframe.contentWindow
    if (!win) {
      iframe.remove()
      return
    }
    // Printing is triggered by paged.js' `after` hook, not here — pagination
    // is asynchronous. Just arm the cleanup paths.
    win.onafterprint = () => iframe.remove()
    window.setTimeout(() => {
      if (document.body.contains(iframe)) iframe.remove()
    }, 120_000)
  }
  iframe.srcdoc = pagedPdfDocument(title, bodyHtml)
  document.body.appendChild(iframe)
}

/** Run one export. `bodyHtml`/`text` come from the tiptap editor. */
export function exportDocument(
  format: ExportFormat,
  title: string,
  bodyHtml: string,
  text: string
): void {
  switch (format) {
    case 'pdf':
      return exportPdf(title, bodyHtml)
    case 'docx':
      return exportDoc(title, bodyHtml)
    case 'html':
      return exportHtml(title, bodyHtml)
    case 'txt':
      return exportTxt(title, text)
  }
}
