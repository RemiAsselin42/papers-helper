import { Extension } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      /** Apply a CSS font-size (e.g. "14pt") to the current selection. */
      setFontSize: (size: string) => ReturnType
      /** Drop the font-size override, falling back to the editor default. */
      unsetFontSize: () => ReturnType
    }
  }
}

/**
 * Adds a `fontSize` attribute to the `textStyle` mark — tiptap v2 ships no
 * official font-size extension, so this is the documented community pattern.
 * Requires `@tiptap/extension-text-style` (TextStyle) to be registered.
 */
export const FontSize = Extension.create<{ types: string[] }>({
  name: 'fontSize',

  addOptions() {
    return { types: ['textStyle'] }
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {}
              return { style: `font-size: ${attributes.fontSize}` }
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setFontSize:
        (size: string) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    }
  },
})
