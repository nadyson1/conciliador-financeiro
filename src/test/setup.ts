import '@testing-library/jest-dom/vitest'

if (!Blob.prototype.text) {
  Object.defineProperty(Blob.prototype, 'text', {
    configurable: true,
    value: function text(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(this)
      })
    },
  })
}

if (!URL.createObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
if (!URL.revokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
