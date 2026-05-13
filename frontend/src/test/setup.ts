import '@testing-library/jest-dom'

// jsdom breaks localStorage when --localstorage-file is given without a valid
// path (the warning "was provided without a valid path"). Replace with a
// reliable in-memory shim so App's localStorage calls work in tests.
const store: Record<string, string> = {}
const localStorageMock: Storage = {
  getItem: (key) => store[key] ?? null,
  setItem: (key, value) => {
    store[key] = value
  },
  removeItem: (key) => {
    delete store[key]
  },
  clear: () => {
    for (const k in store) delete store[k]
  },
  get length() {
    return Object.keys(store).length
  },
  key: (i) => Object.keys(store)[i] ?? null,
}
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})
