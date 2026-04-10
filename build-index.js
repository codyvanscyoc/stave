const books = ['genesis','exodus','leviticus','numbers','deuteronomy','joshua','judges','ruth','1samuel','2samuel','1kings','2kings','1chronicles','2chronicles','ezra','nehemiah','esther','job','psalms','proverbs','ecclesiastes','songofsolomon','isaiah','jeremiah','lamentations','ezekiel','daniel','hosea','joel','amos','obadiah','jonah','micah','nahum','habakkuk','zephaniah','haggai','zechariah','malachi','matthew','mark','luke','john','acts','romans','1corinthians','2corinthians','galatians','ephesians','philippians','colossians','1thessalonians','2thessalonians','1timothy','2timothy','titus','philemon','hebrews','james','1peter','2peter','1john','2john','3john','jude','revelation']

const SKIP = new Set(['the','and','of','to','a','in','that','he','was','his','for','it','with','as','be','at','by','are','this','or','an','but','not','from','all','have','they','which','one','you','were','had','has','their','will','there','what','so','if','up','out','when','who','him','its','do','how','my','we','your','said','on','is','i','me','no','more','than','then','them','into','her','our','upon','also','about','after','over','before','shall','these','those','would','could','should','been','may','did','now','come','came','went','away','down','through','from','every','any','both','own','such','even','only','other','where','while','yet','into','unto','lord','god','yahweh','jesus','christ'])

const index = {}

books.forEach(book => {
  let data
  try { data = require('world-english-bible/json/' + book + '.json') } catch(e) { console.log('skipping', book); return }
  const bookName = book.charAt(0).toUpperCase() + book.slice(1)
  data.forEach(item => {
    if (!item.value || !item.chapterNumber || !item.verseNumber) return
    const ref = bookName + ' ' + item.chapterNumber + ':' + item.verseNumber
    const text = item.value.trim()
    const words = text.toLowerCase().replace(/[^a-z\s]/g,'').split(/\s+/)
    words.forEach(word => {
      if (word.length < 3 || SKIP.has(word)) return
      if (!index[word]) index[word] = []
      const existing = index[word].find(v => v.ref === ref)
      if (!existing) index[word].push({ ref, text: text.slice(0, 120) })
    })
  })
})

require('fs').writeFileSync('bible-index.json', JSON.stringify(index))
const wordCount = Object.keys(index).length
console.log('done. indexed', wordCount, 'words')