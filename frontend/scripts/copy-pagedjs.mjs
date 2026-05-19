/**
 * Copie le polyfill paged.js depuis node_modules vers `public/`.
 *
 * Le polyfill est servi à la racine du site et chargé comme script classique
 * dans l'iframe d'impression (cf. `documentExport.ts`) — il ne peut pas être
 * importé comme un module. Le vendoriser à la main laisse la copie diverger en
 * silence à chaque mise à jour de `pagedjs` ; ce script la resynchronise. Il
 * tourne automatiquement via le script `prebuild` de package.json.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/pagedjs/dist/paged.polyfill.min.js')
const dest = resolve(root, 'public/paged.polyfill.min.js')

if (!existsSync(src)) {
  console.error(`[copy-pagedjs] introuvable : ${src}\nLance "pnpm install" d'abord.`)
  process.exit(1)
}

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[copy-pagedjs] ${src} → ${dest}`)
