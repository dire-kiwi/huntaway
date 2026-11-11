/** Saves `text` as a file called `name`. */
export function download(name: string, text: string, type: string) {
  // Saved as a file, never opened here: a page opened from a blob URL would run with the board's origin.
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function cost(usd: number) {
  if (!usd) return null
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`
}
