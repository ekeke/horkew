<script lang="ts">
  let { open, onclose }: { open: boolean, onclose: () => void } = $props()

  let panelBody: HTMLDivElement | undefined = $state()

  export function scrollToId(id: string) {
    requestAnimationFrame(() => {
      const el = panelBody?.querySelector(`#${CSS.escape(id)}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  function onTocClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const id = a.getAttribute('href')?.slice(1)
    if (id) {
      history.replaceState(null, '', `#${id}`)
      scrollToId(id)
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" class:visible={open} onclick={onclose}></div>
{/if}
<aside class="panel" class:open>
  <div class="panel-header">
    <span class="panel-title">Horkew ヘルプ</span>
    <button class="close-btn" onclick={onclose}>&times;</button>
  </div>
  <div class="panel-body" bind:this={panelBody}>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <nav class="toc" onclick={onTocClick}>
      <ul>
        <li><a href="#help-about">Horkewとは</a>
          <ul>
            <li><a href="#help-about-overview">概要・コンセプト</a></li>
          </ul>
        </li>
        <li><a href="#help-basics">基本の使い方</a>
          <ul>
            <li><a href="#help-basics-games">ゲームの作成・切替・削除</a></li>
            <li><a href="#help-basics-input">テキスト入力による記録スタイル</a></li>
          </ul>
        </li>
        <li><a href="#help-notation">入力方法</a>
          <ul>
            <li><a href="#help-notation-structure">ドキュメント構造</a></li>
            <li><a href="#help-notation-join">参加者の登録</a></li>
            <li><a href="#help-notation-input-player-name">プレイヤー名の入力</a></li>
            <li><a href="#help-notation-assert">CO・主張</a>
              <ul>
                <li><a href="#help-notation-assert-co">役職CO</a></li>
                <li><a href="#help-notation-assert-neg">否定CO・複合CO</a></li>
                <li><a href="#help-notation-assert-result">占い・霊媒結果</a></li>
                <li><a href="#help-notation-assert-bulk">一括CO (生存者)</a></li>
              </ul>
            </li>
            <li><a href="#help-notation-death">死亡イベント</a>
              <ul>
                <li><a href="#help-notation-death-lynch">処刑</a></li>
                <li><a href="#help-notation-death-attack">襲撃</a></li>
                <li><a href="#help-notation-death-curse">道連れ・後追い</a></li>
                <li><a href="#help-notation-death-peace">平和</a></li>
              </ul>
            </li>
            <li><a href="#help-notation-vote">投票</a>
              <ul>
                <li><a href="#help-notation-vote-single">個別投票 (→)</a></li>
                <li><a href="#help-notation-vote-multi">一括投票 (←)</a></li>
                <li><a href="#help-notation-vote-revote">再投票</a></li>
              </ul>
            </li>
            <li><a href="#help-notation-other">その他</a>
              <ul>
                <li><a href="#help-notation-other-mason">共有確認</a></li>
                <li><a href="#help-notation-other-reveal">役職公開</a></li>
                <li><a href="#help-notation-other-over">決着</a></li>
              </ul>
            </li>
            <li><a href="#help-notation-roles">役職名・記号一覧</a></li>
            <li><a href="#help-notation-frontmatter">Frontmatterオプション</a></li>
          </ul>
        </li>
        <li><a href="#help-views">画面の見方</a>
          <ul>
            <li><a href="#help-views-status">ステータス画面</a>
              <ul>
                <li><a href="#help-views-status-survivors">生存者一覧</a></li>
                <li><a href="#help-views-status-votes">投票状況</a></li>
                <li><a href="#help-views-status-deaths">死亡履歴</a></li>
                <li><a href="#help-views-status-claims">CO表</a></li>
              </ul>
            </li>
            <li><a href="#help-views-analysis">役職推理 (Analysis)</a>
              <ul>
                <li><a href="#help-views-analysis-grid">可能役職の見方</a></li>
                <li><a href="#help-views-analysis-assume">仮定の使い方</a></li>
                <li><a href="#help-views-analysis-gmork">矛盾理由の表示 (Gmork)</a></li>
              </ul>
            </li>
            <li><a href="#help-views-dialog">プレイヤー詳細ダイアログ</a>
              <ul>
                <li><a href="#help-views-dialog-info">基本情報・判定</a></li>
                <li><a href="#help-views-dialog-relation">関連プレイヤーの操作</a></li>
                <li><a href="#help-views-dialog-votes">投票関係の履歴</a></li>
              </ul>
            </li>
          </ul>
        </li>
        <li><a href="#help-settings">設定</a>
          <ul>
            <li><a href="#help-settings-skin">スキン (Flat / Excite)</a></li>
            <li><a href="#help-settings-panes">ペイン表示の切替</a></li>
          </ul>
        </li>
        <li><a href="#help-faq">FAQ</a>
          <ul>
            <li><a href="#help-faq-cursor">カーソル位置で解析範囲が変わる？</a></li>
            <li><a href="#help-faq-name">名前が認識されない</a></li>
            <li><a href="#help-faq-frontmatter">Frontmatterオプション</a></li>
            <li><a href="#help-faq-analyzer">ゲーム終了時にアナライザの結果が表示されない</a></li>
          </ul>
        </li>
      </ul>
    </nav>

    <!-- ===== Horkewとは ===== -->
    <section id="help-about">
      <h2 id="help-about-overview">概要・コンセプト</h2>
      <p>Horkewは、人狼ゲームの進行をテキストで記録し、リアルタイムに盤面を可視化・推理するためのツールです。</p>
      <p>独自の速記法 <strong>Howl記法</strong> を使って、参加者・CO・投票・死亡などのイベントをテキストとして入力すると、盤面の状態や各プレイヤーの可能役職が自動的に計算されます。</p>
      <p>ボタン操作ではなくフルテキスト入力方式のため、ゲームの進行を素早く記録でき、あとから編集・見返しも容易です。</p>
    </section>

    <!-- ===== 基本の使い方 ===== -->
    <section id="help-basics">
      <h2>基本の使い方</h2>

      <h3 id="help-basics-games">ゲームの作成・切替・削除</h3>
      <p>ヘッダーの <strong>New</strong> ボタンでゲームを作成します。タイトルを入力すると新しい編集画面が開きます。</p>
      <p>ドロップダウンで保存済みのゲームを切り替えられます。<strong>Del</strong> ボタンで現在のゲームを削除します。</p>
      <p>すべてのデータはブラウザの localStorage に自動保存されます。</p>

      <h3 id="help-basics-input">テキスト入力による記録スタイル</h3>
      <p>Horkewはフォームやボタンで入力するツールではありません。左側のテキストエリアにHowl記法でゲームの進行を直接書き込みます。</p>
      <p>入力すると即座に解析され、右側のステータス画面や推理テーブルに結果が反映されます。テキストを修正すれば結果もリアルタイムに更新されます。</p>
    </section>

    <!-- ===== 入力方法 ===== -->
    <section id="help-notation">
      <h2>入力方法</h2>

      <h3 id="help-notation-structure">ドキュメント構造</h3>
      <p>Howlドキュメントは <strong>YAML frontmatter</strong>（省略可）と<strong>記法本体</strong>で構成されます。</p>
      <pre><code>---
title: 3日目決着村
vote.style: ordered
---
+アリス ボブ チャーリー デイブ エミリー
アリス: 占いCO ボブ白
ボブ → チャーリー
チャーリー → ボブ
...</code></pre>
      <p><code>#</code> で始まる行はコメントとして無視されます。</p>

      <h3 id="help-notation-join">参加者の登録</h3>
      <p><code>++</code> で複数人を一括登録、<code>+</code> で一人ずつ登録できます。</p>
      <h4>一括登録 (++)</h4>
      <pre><code>++アリス ボブ チャーリー
++アリス、ボブ、チャーリー</code></pre>
      <p>区切り文字はスペース・<code>,</code>・<code>、</code> などが使えます。</p>

      <h4>個別登録 (+)</h4>
      <p>一人ずつ登録し、短縮名や検索エイリアスを設定できます。</p>
      <pre><code>+ アリス
+ アリス(ア)
+ アリス(ア) Alice あり</code></pre>
      <p>最初のトークンがプレイヤー名です。<code>()</code> / <code>（）</code> で囲んだ部分が表示用短縮名になります。以降のトークンは検索用エイリアスとして登録されます。</p>

      <h4>名前にスペースを含める</h4>
      <p>クォート（<code>"</code> <code>'</code> や全角・スマートクォート）で囲むと、スペースを含む名前を登録できます。</p>
      <pre><code>++ "藤澤 仁" "児玉　健" ボブ
+ "村中　秀史"（村中） むらなか</code></pre>

      <p>参加行は自動的に先頭に移動されるため、文中のどこに書いても構いません。</p>

      <h3 id="help-notation-input-player-name">プレイヤー名の入力</h3>
      <p>登録済みの名前に対して、以下の順で柔軟に照合されます:</p>
      <ol>
        <li><strong>前方一致</strong> — <code>ア</code> → アリス</li>
        <li><strong>部分一致</strong> — <code>リス</code> → アリス</li>
      </ol>
      <p>カタカナとひらがなは同一視されます。一意に特定できない場合はマッチしません。</p>
      <p>この仕組みにより、長い名前でも数文字の省略形で入力できます。</p>
    </section>

    <!-- CO・主張 -->
    <section id="help-notation-assert">
      <h2>CO・主張</h2>

      <h3 id="help-notation-assert-co">役職CO</h3>
      <p>プレイヤー名の後にコロンを置き、<code>役職名CO</code> と占い・霊媒結果を記述します。</p>
      <pre><code>アリス: 占いCO ボブ白 チャーリー●
ボブ: 霊媒CO アリス○
チャーリー: 狩人CO 1日目 護衛 アリス
デイブ: 共有CO
エミリー: 猫又CO</code></pre>

      <h3 id="help-notation-assert-neg">否定CO・複合CO</h3>
      <p><code>非</code> を前置すると「その役職ではない」という主張になります。</p>
      <pre><code>アリス: 非占いCO
ボブ: 非猫CO</code></pre>
      <p>複数の役職略称を連結すると複合COになります。</p>
      <pre><code>アリス: 猫狩CO</code></pre>

      <h3 id="help-notation-assert-result">占い・霊媒結果</h3>
      <p>CO行の中で、対象名の直後に結果記号を書きます。</p>
      <table>
        <tbody>
          <tr><th>人間 (白)</th><td><code>白</code> <code>○</code> <code>◯</code></td></tr>
          <tr><th>人狼 (黒)</th><td><code>黒</code> <code>●</code></td></tr>
        </tbody>
      </table>
      <p>日数指定: <code>1日目</code> <code>2日</code> <code>3d</code> など、数字+日単位で指定できます。</p>

      <h3 id="help-notation-assert-bulk">一括CO (生存者)</h3>
      <p>キーワード <code>生存者</code> で全生存者の一括COを記述できます。</p>
      <pre><code>生存者 占いCO
生存者 非猫CO</code></pre>
    </section>

    <!-- 死亡イベント -->
    <section id="help-notation-death">
      <h2>死亡イベント</h2>

      <h3 id="help-notation-death-lynch">処刑</h3>
      <pre><code>吊り アリス
処刑 アリス
アリス 吊り
処刑者なし</code></pre>
      <p>キーワード: <code>吊り</code> <code>吊</code> <code>処刑</code><br>
      処刑なし: <code>処刑者なし</code> <code>吊りなし</code></p>

      <h3 id="help-notation-death-attack">襲撃</h3>
      <pre><code>襲撃 アリス
噛み ボブ
アリス 死亡</code></pre>
      <p>キーワード: <code>襲撃</code> <code>噛み</code> <code>噛</code> <code>死亡</code></p>

      <h3 id="help-notation-death-curse">道連れ・後追い</h3>
      <pre><code>道連れ アリス
アリス 道連れ
後追い ボブ
ボブ 後追い</code></pre>
      <p><code>道連れ</code>: 猫又による呪殺<br>
      <code>後追い</code>: 背徳者の後追い死</p>

      <h3 id="help-notation-death-peace">平和</h3>
      <pre><code>平和</code></pre>
      <p>襲撃による死亡者がなかった場合に記述します。</p>
    </section>

    <!-- 投票 -->
    <section id="help-notation-vote">
      <h2>投票</h2>

      <h3 id="help-notation-vote-single">個別投票 (→)</h3>
      <p>右矢印で投票者→投票先を記述します。</p>
      <pre><code>アリス → ボブ
アリス -> ボブ
アリス => ボブ</code></pre>
      <table>
        <caption>使用可能な右矢印</caption>
        <tbody>
          <tr><th>Unicode</th><td><code>→</code> <code>⇒</code></td></tr>
          <tr><th>ASCII</th><td><code>-&gt;</code> <code>=&gt;</code></td></tr>
        </tbody>
      </table>

      <h3 id="help-notation-vote-multi">一括投票 (←)</h3>
      <p>左矢印で投票先←投票者たちを記述します。</p>
      <pre><code>ボブ ← アリス、チャーリー、デイブ
ボブ &lt;- アリス チャーリー デイブ</code></pre>
      <table>
        <caption>使用可能な左矢印</caption>
        <tbody>
          <tr><th>Unicode</th><td><code>←</code> <code>⇐</code></td></tr>
          <tr><th>ASCII</th><td><code>&lt;-</code> <code>&lt;=</code></td></tr>
        </tbody>
      </table>

      <h3 id="help-notation-vote-revote">再投票</h3>
      <pre><code>再投票
---
再投票 アリス ボブ</code></pre>
      <p><code>---</code> <code>===</code> <code>再投票</code> のいずれかで記述。対象者を指定すると決選投票の候補を明示できます。</p>
    </section>

    <!-- その他 -->
    <section id="help-notation-other">
      <h2>その他</h2>

      <h3 id="help-notation-other-mason">共有確認</h3>
      <pre><code>共有 アリス ボブ</code></pre>
      <p>共有者のペアを明示します。</p>

      <h3 id="help-notation-other-reveal">役職公開</h3>
      <pre><code>アリス = 人狼
ボブ = 狂人</code></pre>
      <p>ゲーム終了後の役職公開を記述します。</p>

      <h3 id="help-notation-other-over">決着</h3>
      <pre><code>村勝ち
人狼勝利
狐勝ち
引き分け</code></pre>
      <p>陣営: <code>村</code> <code>狼</code> <code>狐</code> / 勝利: <code>勝ち</code> <code>勝利</code> <code>勝</code></p>
    </section>

    <!-- 役職名・記号一覧 -->
    <section id="help-notation-roles">
      <h2>役職名・記号一覧</h2>
      <table>
        <thead>
          <tr><th>役職</th><th>略称</th></tr>
        </thead>
        <tbody>
          <tr><td>占い師</td><td><code>占い</code> <code>占</code> <code>預言</code> <code>予言</code></td></tr>
          <tr><td>霊媒師</td><td><code>霊媒</code> <code>霊能</code> <code>霊</code></td></tr>
          <tr><td>狩人</td><td><code>狩</code> <code>護衛</code> <code>護</code></td></tr>
          <tr><td>共有者</td><td><code>共有</code> <code>共</code></td></tr>
          <tr><td>猫又</td><td><code>猫</code></td></tr>
          <tr><td>人狼</td><td><code>狼</code></td></tr>
          <tr><td>狂人</td><td><code>狂</code> <code>狂信者</code></td></tr>
          <tr><td>妖狐</td><td><code>狐</code></td></tr>
          <tr><td>背徳者</td><td><code>背徳</code> <code>背</code></td></tr>
        </tbody>
      </table>
    </section>

    <!-- Frontmatter -->
    <section id="help-notation-frontmatter">
      <h2>Frontmatterオプション</h2>
      <p>ドキュメント先頭の <code>---</code> で囲んだ YAML ブロックで、ゲームのルールを設定できます。</p>
      <table>
        <thead>
          <tr><th>キー</th><th>値</th><th>既定</th></tr>
        </thead>
        <tbody>
          <tr><td><code>vote.style</code></td><td>free / ordered / concurrent</td><td>free</td></tr>
          <tr><td><code>vote.final</code></td><td>revote / final</td><td>final</td></tr>
          <tr><td><code>vote.tiebreaker</code></td><td>random / no-lynch</td><td>no-lynch</td></tr>
          <tr><td><code>first-victim</code></td><td>none / random / first-vote</td><td>none</td></tr>
          <tr><td><code>general.countFirstDay</code></td><td>true / false</td><td>false</td></tr>
        </tbody>
      </table>
    </section>

    <!-- ===== 画面の見方 ===== -->
    <section id="help-views">
      <h2>画面の見方</h2>
    </section>

    <!-- ステータス画面 -->
    <section id="help-views-status">
      <h2>ステータス画面</h2>
      <p>入力内容から自動生成されるゲーム状況の概要です。プレイヤー名はどこでもクリックして詳細を確認できます。</p>

      <h3 id="help-views-status-survivors">生存者一覧</h3>
      <p>現在の生存者数と生存プレイヤーの一覧をバッジで表示します。</p>

      <h3 id="help-views-status-votes">投票状況</h3>
      <p>投票が発生すると表示され、処刑・平和が確定すると非表示になります。</p>
      <p>各行には投票先・得票数・投票者が表示されます。得票の多い順に並び、<strong>処刑確定ライン</strong>が黄色の太線で示されます。</p>
      <p>処刑確定した行は赤背景、決選確定は橙背景で強調されます。確定票を投じた決定的投票者は太字で表示されます。</p>

      <h3 id="help-views-status-deaths">死亡履歴</h3>
      <p>夜ごとの襲撃死者と処刑者を2行のテーブルで一覧表示します。</p>

      <h3 id="help-views-status-claims">CO表</h3>
      <p>役職別のCO状況を表形式で表示します。</p>
      <p>占い師・霊媒師は夜ごとの占い/霊媒結果を、狩人は護衛先を列で表示します。結果は <span style="color:#a6e3a1">○</span> (白) / <span style="color:#f38ba8">●</span> (黒) で色分けされます。</p>
      <p>共有者はペアをグループ化して表示します。</p>
    </section>

    <!-- 役職推理 -->
    <section id="help-views-analysis">
      <h2>役職推理 (Analysis)</h2>

      <h3 id="help-views-analysis-grid">可能役職の見方</h3>
      <p>プレイヤー × 役職のグリッドで、各プレイヤーがなりうる役職を表示します。</p>
      <p>明るいセルはその役職の可能性あり、暗いセルは不可能です。左端にはプレイヤー名と陣営の判定ラベルが色分けで表示されます。</p>
      <table>
        <tbody>
          <tr><th style="color:#a6e3a1">村</th><td>村人陣営確定</td></tr>
          <tr><th style="color:#f38ba8">狼</th><td>人狼陣営確定</td></tr>
          <tr><th style="color:#f9e2af">狐</th><td>妖狐陣営確定</td></tr>
          <tr><th style="color:#cba6f7">?</th><td>複数陣営の可能性あり</td></tr>
        </tbody>
      </table>

      <h3 id="help-views-analysis-assume">仮定の使い方</h3>
      <p>グリッドのセルをクリックすると、そのプレイヤーをその役職だと<strong>仮定</strong>できます。仮定セルは紫色で強調されます。</p>
      <p>仮定を設定すると、その条件下で他のプレイヤーの可能役職が再計算されます。もう一度クリックすると仮定を解除します。</p>

      <h3 id="help-views-analysis-gmork">矛盾理由の表示 (Gmork)</h3>
      <p>不可能な役職セルをクリックして仮定すると、グリッドの下にその仮定がなぜ矛盾するかの理由が日本語で表示されます。</p>
      <p>「なぜこの人がこの役職ではありえないのか」を論理的に確認するのに役立ちます。</p>
    </section>

    <!-- プレイヤー詳細ダイアログ -->
    <section id="help-views-dialog">
      <h2>プレイヤー詳細ダイアログ</h2>
      <p>画面上のプレイヤー名をクリックすると開きます。</p>

      <h3 id="help-views-dialog-info">基本情報・判定</h3>
      <p>選択したプレイヤーの役職CO・生存状態・陣営判定を表示します。</p>
      <p>占い師・霊媒師からそのプレイヤーに出されている判定結果も一覧されます。</p>

      <h3 id="help-views-dialog-relation">関連プレイヤーの操作</h3>
      <p>ダイアログ下部で他のプレイヤーとの関係を確認できます。<strong>&lt;</strong> <strong>&gt;</strong> ボタンまたは左右キーで対象を切り替えます。</p>
      <p>対象プレイヤーのCO・生存状態・判定・可能役職が表示されます。</p>

      <h3 id="help-views-dialog-votes">投票関係の履歴</h3>
      <p>選択プレイヤーと対象プレイヤーが互いに投票した履歴を日ごとに表示します。</p>
      <p>当日の投票には処刑確定票・決戦確定票・救済票のタグが付きます。</p>
    </section>

    <!-- ===== 設定 ===== -->
    <section id="help-settings">
      <h2>設定</h2>

      <h3 id="help-settings-skin">スキン (Flat / Excite)</h3>
      <p>ヘッダーのドロップダウンで外観テーマを切り替えられます。</p>
      <p><strong>Flat</strong>: シンプルな取り消し線で死亡を表示<br>
      <strong>Excite</strong>: 襲撃に斜線エフェクト、処刑に溶解エフェクトを適用</p>

      <h3 id="help-settings-panes">ペイン表示の切替</h3>
      <p>ヘッダーの <strong>Panes</strong> ボタンで各ペインの表示/非表示を切り替えられます。設定はブラウザに保存されます。</p>
    </section>

    <!-- ===== FAQ ===== -->
    <section id="help-faq">
      <h2>FAQ</h2>

      <h3 id="help-faq-cursor">カーソル位置で解析範囲が変わる？</h3>
      <p>はい。パフォーマンスのため、入力テキストはカーソル行までが解析対象です。最終行にカーソルを置くと全体が解析されます。</p>

      <h3 id="help-faq-name">名前が認識されない</h3>
      <p>プレイヤー名は <code>+</code> または <code>++</code> 行で先に登録する必要があります。省略形は一意に特定できる場合のみマッチします。同じ前方一致になる名前が複数ある場合は、より多くの文字を入力してください。</p>

      <h3 id="help-faq-frontmatter">Frontmatterオプション</h3>
      <p>Frontmatterはドキュメントの先頭に <code>---</code> で囲んで記述します。詳細は<a href="#help-notation-frontmatter">入力方法 &gt; Frontmatterオプション</a>を参照してください。</p>

      <h3 id="help-faq-analyzer">ゲーム終了時にアナライザの結果が表示されない</h3>
      <p>アナライザは、標準状態ではゲームが続いている、つまり人狼が1匹以上生存している前提で分析を行います。そのため、人狼が論理的に全滅した場合など盤面との齟齬が起こる場合があります。</p>
      <p>ゲーム終了行（<code>人狼勝利</code>、<code>村勝ち</code> など）を入力してください。</p>
    </section>
  </div>
</aside>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 200;
    opacity: 0;
    animation: fade-in 0.3s ease forwards;
  }

  @keyframes fade-in {
    to { opacity: 1; }
  }

  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 90vw);
    z-index: 201;
    background: #1e1e2e;
    border-left: 1px solid #45475a;
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.3s ease;
  }

  .panel.open {
    transform: translateX(0);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1rem;
    height: 40px;
    min-height: 40px;
    background: #181825;
    border-bottom: 1px solid #313244;
  }

  .panel-title {
    font-size: 14px;
    font-weight: 600;
    color: #cba6f7;
  }

  .close-btn {
    background: none;
    border: none;
    color: #a6adc8;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: #cdd6f4;
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    font-size: 13px;
    line-height: 1.7;
    color: #cdd6f4;
  }

  .toc ul {
    list-style: none;
    margin: 0;
    padding-left: 1rem;
  }

  .toc > ul {
    padding-left: 0;
  }

  .toc li {
    margin: 2px 0;
  }

  .toc > ul > li {
    margin-top: 6px;
  }

  .toc > ul > li:first-child {
    margin-top: 0;
  }

  .toc a {
    color: #89b4fa;
    text-decoration: none;
    font-size: 12px;
  }

  .toc a:hover {
    text-decoration: underline;
  }

  .toc > ul > li > a {
    font-weight: 600;
    font-size: 13px;
    color: #cdd6f4;
  }

  .panel-body section {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid #313244;
  }

  .panel-body section:last-child {
    border-bottom: none;
  }

  .panel-body h2 {
    font-size: 15px;
    font-weight: 600;
    color: #cba6f7;
    margin: 0 0 0.5rem 0;
  }

  .panel-body h3 {
    font-size: 13px;
    font-weight: 600;
    color: #a6adc8;
    margin: 0.75rem 0 0.25rem 0;
  }

  .panel-body p {
    margin: 0.4rem 0;
  }

  .panel-body code {
    background: #313244;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 12px;
  }

  .panel-body pre {
    background: #181825;
    border: 1px solid #313244;
    border-radius: 6px;
    padding: 8px 12px;
    margin: 0.5rem 0;
    overflow-x: auto;
  }

  .panel-body pre code {
    background: none;
    padding: 0;
    font-size: 12px;
    line-height: 1.6;
  }

  .panel-body table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.5rem 0;
    font-size: 12px;
  }

  .panel-body caption {
    text-align: left;
    font-size: 12px;
    color: #a6adc8;
    margin-bottom: 4px;
  }

  .panel-body th,
  .panel-body td {
    padding: 4px 8px;
    border: 1px solid #313244;
    text-align: left;
  }

  .panel-body th {
    background: #181825;
    color: #a6adc8;
    font-weight: 500;
    white-space: nowrap;
  }

  .panel-body ol,
  .panel-body ul {
    margin: 0.4rem 0;
    padding-left: 1.5rem;
  }

  .panel-body strong {
    color: #f9e2af;
    font-weight: 600;
  }

  .panel-body section a {
    color: #89b4fa;
    text-decoration: none;
  }

  .panel-body section a:hover {
    text-decoration: underline;
  }
</style>
