export type Signal =
  | { type: 'execute_proposal', target: number }
  | { type: 'suspicion', target: number }
  | { type: 'trust', target: number }
  | { type: 'agree', signalId: number }
  | { type: 'disagree', signalId: number }
  | { type: 'no_signal' }

export type SignalRecord = {
  id: number
  sender: number
  day: number
  signal: Signal
}
