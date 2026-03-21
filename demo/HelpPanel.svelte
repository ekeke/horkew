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
    <span class="panel-title">Howl 記法リファレンス</span>
    <button class="close-btn" onclick={onclose}>&times;</button>
  </div>
  <div class="panel-body" bind:this={panelBody}>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <nav class="toc" onclick={onTocClick}>
      <a href="#help-structure">基本構造</a>
      <a href="#help-join">参加</a>
      <a href="#help-vote">投票</a>
      <a href="#help-multivote">複数投票</a>
      <a href="#help-lynch">処刑</a>
      <a href="#help-attack">襲撃</a>
      <a href="#help-curse">道連れ・後追い</a>
      <a href="#help-revote">再投票</a>
      <a href="#help-peace">平和</a>
      <a href="#help-assert">CO・主張</a>
      <a href="#help-bulk-assert">一括CO</a>
      <a href="#help-mason">共有確認</a>
      <a href="#help-reveal">役職公開</a>
      <a href="#help-over">決着</a>
      <a href="#help-roles">役職名一覧</a>
      <a href="#help-matching">名前マッチング</a>
      <a href="#help-frontmatter">Frontmatter</a>
    </nav>

    <section id="help-structure">
      <h2>基本構造</h2>
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
    </section>

    <section id="help-join">
      <h2>参加 (Join)</h2>
      <p>行頭の <code>+</code> に続けてプレイヤー名を列挙します。</p>
      <pre><code>+アリス ボブ チャーリー
+アリス、ボブ、チャーリー</code></pre>
      <p>区切り文字はスペース・<code>,</code>・<code>、</code> などが使えます。<br>参加行は自動的に先頭に移動されるため、文中のどこに書いても構いません。</p>
    </section>

    <section id="help-vote">
      <h2>投票 (Vote)</h2>
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
    </section>

    <section id="help-multivote">
      <h2>複数投票 (MultiVote)</h2>
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
    </section>

    <section id="help-lynch">
      <h2>処刑 (Lynch)</h2>
      <pre><code>吊り アリス
処刑 アリス
アリス 吊り
処刑者なし</code></pre>
      <p>キーワード: <code>吊り</code> <code>吊</code> <code>処刑</code><br>
      処刑なし: <code>処刑者なし</code> <code>吊りなし</code></p>
    </section>

    <section id="help-attack">
      <h2>襲撃 (Attack)</h2>
      <pre><code>襲撃 アリス
噛み ボブ
アリス 死亡</code></pre>
      <p>キーワード: <code>襲撃</code> <code>噛み</code> <code>噛</code> <code>死亡</code></p>
    </section>

    <section id="help-curse">
      <h2>道連れ・後追い</h2>
      <pre><code>道連れ アリス
アリス 道連れ
後追い ボブ
ボブ 後追い</code></pre>
      <p><code>道連れ</code>: 猫又による呪殺<br>
      <code>後追い</code>: 背徳者の後追い死</p>
    </section>

    <section id="help-revote">
      <h2>再投票 (Revote)</h2>
      <pre><code>再投票
---
再投票 アリス ボブ</code></pre>
      <p><code>---</code> <code>===</code> <code>再投票</code> のいずれかで記述。<br>
      対象者を指定すると決選投票の候補を明示できます。</p>
    </section>

    <section id="help-peace">
      <h2>平和 (Peace)</h2>
      <pre><code>平和</code></pre>
      <p>襲撃による死亡者がなかった場合に記述します。</p>
    </section>

    <section id="help-assert">
      <h2>CO・主張 (Assert)</h2>
      <p>プレイヤー名の後にコロンを置き、役職COや占い・霊媒結果を記述します。</p>
      <pre><code>アリス: 占いCO ボブ白 チャーリー●
ボブ: 霊媒CO アリス○
チャーリー: 狩人CO 1日目 護衛 アリス
デイブ: 共有CO
エミリー: 猫又CO</code></pre>

      <h3>否定CO</h3>
      <pre><code>アリス: 非占いCO
ボブ: 非猫CO</code></pre>
      <p><code>非</code> を前置すると「その役職ではない」という主張になります。</p>

      <h3>複合CO</h3>
      <pre><code>アリス: 猫狩CO</code></pre>
      <p>複数の役職略称を連結できます（猫又または狩人のCO）。</p>

      <h3>占い・霊媒結果</h3>
      <table>
        <tbody>
          <tr><th>人間</th><td><code>白</code> <code>○</code> <code>◯</code></td></tr>
          <tr><th>人狼</th><td><code>黒</code> <code>●</code></td></tr>
        </tbody>
      </table>

      <h3>日数指定</h3>
      <p><code>1日目</code> <code>2日</code> <code>3d</code> など、数字+日単位で指定できます。</p>
    </section>

    <section id="help-bulk-assert">
      <h2>一括CO</h2>
      <p>キーワード <code>生存者</code> を使って、全生存者の一括COを記述できます。</p>
      <pre><code>生存者 占いCO
生存者 非猫CO</code></pre>
    </section>

    <section id="help-mason">
      <h2>共有確認 (Mason)</h2>
      <pre><code>共有 アリス ボブ</code></pre>
      <p>共有者のペアを明示します。</p>
    </section>

    <section id="help-reveal">
      <h2>役職公開 (Reveal)</h2>
      <pre><code>アリス = 人狼
ボブ = 狂人</code></pre>
      <p>ゲーム終了後の役職公開を記述します。</p>
    </section>

    <section id="help-over">
      <h2>決着 (Over)</h2>
      <pre><code>村勝ち
人狼勝利
狐勝ち
引き分け</code></pre>
      <p>陣営: <code>村</code> <code>狼</code> <code>狐</code><br>
      勝利: <code>勝ち</code> <code>勝利</code> <code>勝</code></p>
    </section>

    <section id="help-roles">
      <h2>役職名一覧</h2>
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

    <section id="help-matching">
      <h2>プレイヤー名の柔軟マッチング</h2>
      <p>登録済みの名前に対して、以下の順で照合されます:</p>
      <ol>
        <li><strong>前方一致</strong> — <code>ア</code> → アリス</li>
        <li><strong>部分一致</strong> — <code>リス</code> → アリス</li>
      </ol>
      <p>カタカナとひらがなは同一視されます。<br>
      一意に特定できない場合はマッチしません。</p>
    </section>

    <section id="help-frontmatter">
      <h2>Frontmatter オプション</h2>
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

  .toc {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #313244;
  }

  .toc a {
    color: #89b4fa;
    text-decoration: none;
    font-size: 12px;
  }

  .toc a:hover {
    text-decoration: underline;
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
</style>
