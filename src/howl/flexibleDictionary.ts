function kanaToHira(str: string) {
  return str.replace(/[\u30a1-\u30f6]/g, function(match) {
      const chr = match.charCodeAt(0) - 0x60
      return String.fromCharCode(chr)
  })
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class FlexibleDictionary {
  keywords: { [key: string]: string }
  cache: { [key: string]: string[] }
  constructor () {
    this.keywords = {}
    this.cache = {}
  }

  add( id: string, keywords: string[] ): void {
    for ( const keyword of keywords ) {
      this.addKeyword(id, keyword)
    }
  }

  private addKeyword( id: string, keyword: string ): void {
    this.cache = {}
    const standardized = kanaToHira(keyword)
    if (standardized in this.keywords) {
      throw new Error('Cannot add duplicate keyword: ' + standardized)
    }
    this.keywords[standardized] = id
  }

  search(query_word: string): string[] {
    if ( this.cache[query_word] ) return this.cache[query_word]

    const query = kanaToHira(query_word)
    const escaped = escapeRegExp(query)
    const queries = [ "^" + escaped, escaped ]
    if (query.length == 2) {
      queries.push( "^" + escapeRegExp(query[0]) + "." + escapeRegExp(query[1]) )
      queries.push( escapeRegExp(query[0]) + "." + escapeRegExp(query[1]) )
    }
    for ( const q of queries ) {
      const res = this.searchCore(q)
      if (res.length) {
         this.cache[query_word] = res
         return res
      }
    }
    this.cache[query_word] = []
    return []
  }

  private searchCore (query: string): string[] {
    const re = new RegExp(query)
    const res = Object.keys(this.keywords)
      .filter( kw => re.test(kw) )
      .map( kw => this.keywords[kw] )
      .filter((x, i, self) => self.indexOf(x) === i)
    return res
  }

  searchOne(query_word: string): string {
    const res = this.search(query_word)
    if ( res.length === 0 ) throw new Error('No match for query: ' + query_word)
    if ( res.length > 1 ) throw new Error('Ambiguous query: ' + query_word)
    return res[0]
  }
}
