const SEARCH = 'https://www.google.com/search?q='

/** Turn address-bar input into a URL: a typed address is completed, anything else becomes a search. */
export function resolveInput(input: string): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|view-source):/i.test(text)) return text
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)) {
    return `http://${text}`
  }
  // domain.tld[/path] with no spaces
  if (!/\s/.test(text) && /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return SEARCH + encodeURIComponent(text)
}

export function looksLikeUrl(input: string): boolean {
  return !resolveInput(input).startsWith(SEARCH)
}
