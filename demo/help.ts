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

export const TUTORIAL_TEXT = `# 配役: 村人2, 占い師1, 人狼1, 狂人1
配役 村2 占1 狼1 狂1

# 参加者を登録
++アリス ボブ チャーリー デイブ エミリー

# 1日目: CO（カミングアウト＝役職の宣言）と投票
アリス: 占いCO ボブ白
デイブ: 占いCO チャーリー●

アリス → チャーリー
ボブ → チャーリー
チャーリー → デイブ
デイブ → ボブ
エミリー → チャーリー

チャーリー処刑

# 2日目朝: 夜の襲撃結果
襲撃 デイブ

# 2日目: COと投票
アリス: 2日目 エミリー●

ボブ → エミリー
アリス → エミリー
エミリー → ボブ

エミリー処刑
村勝ち
`
