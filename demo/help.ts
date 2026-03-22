let listener: ((id?: string) => void) | undefined

export function openHelp(sectionId?: string) {
  listener?.(sectionId)
}

export function onOpenHelp(fn: (id?: string) => void) {
  listener = fn
}

let trialListener: ((text: string) => void) | undefined

export function startTrial(text: string) {
  trialListener?.(text)
}

export function onStartTrial(fn: (text: string) => void) {
  trialListener = fn
}
