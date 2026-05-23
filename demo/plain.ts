import PlainLykaonPane from './PlainLykaonPane.svelte'
import { mount } from 'svelte'

const app = mount(PlainLykaonPane, {
  target: document.getElementById('app')!,
})

export default app
