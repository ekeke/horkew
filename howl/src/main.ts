import { parse } from './parser.ts'

const exampleHowl = `---
title: Example Howl File
description: Demonstrates various statement types in the Howl format
author: aklas
date: 2023-10-01
---

+便ールガンカ、花京院、小梅ちゃん、ワンワン、ウルガー、ペガサス盛り、星刻、百面ダイス、ブルファンゴ、泣く女、ビスマス結晶、スレッタ、裁縫龍、グロ中尉

噛み　ルガ

百面ダイス　占いCO　グロ白
グロ　占いCO　小梅ちゃん白
泣く女　占いco　スレッタ○

星　霊CO

共有　ペガサス　裁縫龍

百面ダイス　スレッタ黒

吊り　ダイス

噛み　グロ

泣く　花京院白

星　白

吊り　泣く女

噛み　ペガサス

星　黒

ウルガー　猫狩CO
スレ　猫狩CO
ビス　猫狩CO

吊り　ブル

噛み　裁縫龍

星　白

ビスマス　猫CO
ウル　猫CO

スレ　狩りCO　泣く女護衛　星護衛　星護衛

吊り　ワン

平和

星　黒

スレ　小梅護衛

吊り　花京院

噛み　小梅

星　白

スレ　星護衛

ビスマス　妖狐CO

吊り　ビスマス

星噛

人狼勝利

ダイス＝背徳
グロ＝占い
泣く＝人狼
ペが＝共有
ぶる＝村
裁縫＝共有
ワン＝人狼
花京院＝狂信
小梅＝村
ビス＝狐
星＝霊
ウル＝猫
スレ＝人狼
初日＝狩り
`

const app = document.querySelector<HTMLDivElement>('#app')!

const result = parse(exampleHowl)

const textarea = document.createElement('textarea')
textarea.value = exampleHowl
textarea.rows = 20
textarea.cols = 60
textarea.placeholder = 'Howl記法を入力...'
textarea.addEventListener('input', () => {
  update(textarea.value)
})

const output = document.createElement('pre')
output.style.whiteSpace = 'pre-wrap'
output.style.fontFamily = 'monospace'
output.style.fontSize = '13px'
output.style.maxHeight = '600px'
output.style.overflow = 'auto'
output.style.border = '1px solid #ccc'
output.style.padding = '8px'

function update(text: string) {
  const result = parse(text)
  output.textContent = JSON.stringify(result, null, 2)
}

app.innerHTML = '<h2>Howl Parser</h2>'
app.appendChild(textarea)
app.appendChild(output)

update(exampleHowl)
