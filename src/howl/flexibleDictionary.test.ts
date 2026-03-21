import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FlexibleDictionary } from './flexibleDictionary.ts'

describe('FlexibleDictionary', () => {
  let dictionary: FlexibleDictionary

  beforeEach(() => {
    dictionary = new FlexibleDictionary()
  })

  describe('add', () => {
    it('should add keywords associated with an ID', () => {
      dictionary.add('id1', ['keyword1', 'keyword2'])
      assert.deepEqual(dictionary.search('keyword1'), ['id1'])
      assert.deepEqual(dictionary.search('keyword2'), ['id1'])
    })

    it('should not allow duplicate keywords for the same ID', () => {
      dictionary.add('id1', ['keyword1'])
      assert.throws(() => dictionary.add('id1', ['keyword1']), /Cannot add duplicate keyword/)
    })

    it('should not allow duplicate keywords for different IDs', () => {
      dictionary.add('id1', ['keyword1'])
      assert.throws(() => dictionary.add('id2', ['keyword1']), /Cannot add duplicate keyword/)
    })
  })

  describe('search', () => {
    it('should return the correct ID for an exact match', () => {
      dictionary.add('id1', ['keyword1'])
      const result = dictionary.search('keyword1')
      assert.deepEqual(result, ['id1'])
    })

    it('should return an empty array if no match is found', () => {
      dictionary.add('id1', ['keyword1'])
      const result = dictionary.search('nonexistent')
      assert.deepEqual(result, [])
    })

    it('should handle kana to hira conversion', () => {
      dictionary.add('id1', ['カタカナ'])
      const result = dictionary.search('かたかな')
      assert.deepEqual(result, ['id1'])
    })

    it('should cache results for repeated queries', () => {
      dictionary.add('id1', ['keyword1'])
      const firstResult = dictionary.search('keyword1')
      const secondResult = dictionary.search('keyword1')
      assert.deepEqual(firstResult, secondResult)
    })

    it('should handle queries with length 2 and regex patterns', () => {
      dictionary.add('id1', ['abc'])
      const result = dictionary.search('ac')
      assert.deepEqual(result, ['id1'])
    })
  })

  describe('search with regex metacharacters', () => {
    it('should match player names containing dots literally', () => {
      dictionary.add('id1', ['A.B'])
      assert.deepEqual(dictionary.search('A.B'), ['id1'])
      // '.' should not match arbitrary characters
      assert.deepEqual(dictionary.search('AXB'), [])
    })

    it('should match player names containing parentheses literally', () => {
      dictionary.add('id1', ['player(1)'])
      assert.deepEqual(dictionary.search('player(1)'), ['id1'])
    })

    it('should match player names containing plus literally', () => {
      dictionary.add('id1', ['C++'])
      assert.deepEqual(dictionary.search('C++'), ['id1'])
    })

    it('should match player names containing brackets literally', () => {
      dictionary.add('id1', ['[admin]'])
      assert.deepEqual(dictionary.search('[admin]'), ['id1'])
    })

    it('should not throw on player names with invalid regex chars', () => {
      dictionary.add('id1', ['test*name'])
      assert.doesNotThrow(() => dictionary.search('test*name'))
      assert.deepEqual(dictionary.search('test*name'), ['id1'])
    })

    it('should handle 2-char query with metacharacters', () => {
      dictionary.add('id1', ['a.c'])
      // query ".c" should match the literal substring ".c", not regex ". then c"
      assert.deepEqual(dictionary.search('.c'), ['id1'])
      dictionary.add('id2', ['xyzbc'])
      // "bc" should NOT match ".c" entry via the 2-char omit pattern
      assert.deepEqual(dictionary.search('bc'), ['id2'])
    })
  })

  describe('searchOne', () => {
    it('should return the single matching ID', () => {
      dictionary.add('id1', ['keyword1'])
      const result = dictionary.searchOne('keyword1')
      assert.equal(result, 'id1')
    })

    it('should throw an error if no match is found', () => {
      assert.throws(() => dictionary.searchOne('nonexistent'), /No match for query: nonexistent/)
    })

    it('should throw an error if the query is ambiguous', () => {
      dictionary.add('id1', ['keyword1'])
      dictionary.add('id2', ['keyword2'])
      assert.throws(() => dictionary.searchOne('keyword'), /Ambiguous query: keyword/)
    })
  })

  describe('addKeyword (private)', () => {
    it('should standardize keywords and add them to the dictionary', () => {
      // @ts-expect-error Accessing private method for testing
      dictionary.addKeyword('id1', 'カタカナ')
      assert.deepEqual(dictionary.search('かたかな'), ['id1'])
    })
  })

  describe('searchCore (private)', () => {
    it('should return matching IDs based on a regex query', () => {
      dictionary.add('id1', ['keyword1'])
      dictionary.add('id2', ['keyword2'])
      // @ts-expect-error Accessing private method for testing
      const result = dictionary.searchCore('^keyword')
      assert.deepEqual(result, ['id1', 'id2'])
    })
  })
})
