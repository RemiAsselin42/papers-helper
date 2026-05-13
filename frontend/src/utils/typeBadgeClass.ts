// Maps a source-type token (e.g. 'pdf', 'Url') to the CSS-Modules badge class
// emitted by the `source-type-badges` mixin in styles/_mixins.scss. Each
// caller passes its own `styles` map so the lookup resolves to the class
// scoped inside that module file.
//
// Typing strategy: `BadgeStylesMap` enumerates every class name this helper
// can ever ask for. The `as const satisfies` on `TYPE_TO_CLASS` makes
// renaming a key in `BadgeStylesMap` a compile-time error here, so the map
// can't drift away from the SCSS module silently.

export interface BadgeStylesMap {
  badgePdf?: string
  badgeDocx?: string
  badgeTxt?: string
  badgeOdt?: string
  badgeRtf?: string
  badgeHtml?: string
  badgeEpub?: string
  badgeUrl?: string
  badgeFallback?: string
}

type BadgeClassKey = Exclude<keyof BadgeStylesMap, 'badgeFallback'>

const TYPE_TO_CLASS = {
  pdf: 'badgePdf',
  docx: 'badgeDocx',
  txt: 'badgeTxt',
  odt: 'badgeOdt',
  rtf: 'badgeRtf',
  html: 'badgeHtml',
  htm: 'badgeHtml',
  epub: 'badgeEpub',
  url: 'badgeUrl',
} as const satisfies Record<string, BadgeClassKey>

export function typeBadgeClass(type: string, styles: BadgeStylesMap): string | undefined {
  const key = TYPE_TO_CLASS[type.toLowerCase() as keyof typeof TYPE_TO_CLASS]
  return key ? styles[key] : styles.badgeFallback
}
