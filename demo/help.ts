let listener: ((id?: string) => void) | undefined

export function openHelp(sectionId?: string) {
  listener?.(sectionId)
}

export function onOpenHelp(fn: (id?: string) => void) {
  listener = fn
}
