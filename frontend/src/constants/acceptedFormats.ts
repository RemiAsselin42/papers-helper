export const ACCEPTED_DOC_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.txt',
  '.odt',
  '.rtf',
  '.html',
  '.htm',
  '.epub',
  '.bib',
] as const

export const ACCEPTED_DOC_EXTENSIONS_SET = new Set<string>(ACCEPTED_DOC_EXTENSIONS)

/** Value for <input accept="..."> */
export const ACCEPTED_INPUT_ATTR = ACCEPTED_DOC_EXTENSIONS.join(',')

export function isAcceptedDocument(file: File): boolean {
  const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase()
  return ACCEPTED_DOC_EXTENSIONS_SET.has(ext)
}

/**
 * Source types that the browser can render natively in an iframe.
 * Formats like docx, odt, rtf, epub require conversion and are not previewable.
 */
export const IFRAME_PREVIEWABLE_TYPES = new Set(['pdf', 'html', 'txt'])

/**
 * Maps a file extension (without leading dot, lowercase) to its canonical source_type.
 * Used to derive a stable type from the filename when source_type from the API may be stale.
 */
export const EXT_TO_TYPE: Readonly<Record<string, string>> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'txt',
  odt: 'odt',
  rtf: 'rtf',
  html: 'html',
  htm: 'html',
  epub: 'epub',
}
